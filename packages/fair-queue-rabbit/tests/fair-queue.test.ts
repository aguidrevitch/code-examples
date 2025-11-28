import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "@jest/globals";
import { FairQueue, FairQueuePayload } from "../src/index.mjs";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import { RabbitMQContainer, StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import Debug  from "debug";
// import wtf from "wtfnode";
// wtf.init();

const debug = Debug("test");

type GeneratedPayload = [payload: FairQueuePayload, concurrency: number | undefined];

const generateAddRequest = (url: string, concurrency?: number): GeneratedPayload => {
    return [
        {
            url,
            auth: {
                username: "username",
                password: "password",
            },
        },
        concurrency,
    ];
};

async function expectResolvesToMatchObject<T>(promise: Promise<T>, expected: Record<string, unknown>): Promise<T> {
    const result = await promise;
    expect(result).toMatchObject(expected);
    return result;
}

describe("FairQueue", () => {
    let redisContainer: StartedRedisContainer;
    let rabbitmqContainer: StartedRabbitMQContainer; 
    let queueName: string;
    let fq: FairQueue<FairQueuePayload, string>;

    // Helper functions to get connection details
    const getRedisConfig = () => ({
        host: redisContainer.getHost(),
        port: redisContainer.getMappedPort(6379),
        // maxRetriesPerRequest: 1, // to speed up failed tests
        // reconnectOnError(err: Error) {
        //     console.log("Redis reconnectOnError", err);
        //     return false;
        // }
    });

    const getRabbitConfig = () => {
        const host = rabbitmqContainer.getHost();
        const port = rabbitmqContainer.getMappedPort(5672);
        return {
            amqpUrl: `amqp://guest:guest@${host}:${port}`,
        };
    };

    beforeAll(async () => {
        // Start Redis container
        ([ redisContainer, rabbitmqContainer ] = await Promise.all([
            new RedisContainer("redis:7-alpine")
                .withExposedPorts(6379)
                .withStartupTimeout(60_000)
                .start(),
            new RabbitMQContainer("rabbitmq:4-alpine")
                .withExposedPorts(5672)
                .withEnvironment({
                    RABBITMQ_DEFAULT_USER: "guest",
                    RABBITMQ_DEFAULT_PASS: "guest",
                })
                .withStartupTimeout(60_000)
                .start()
        ]));
    }, 120_000);


    beforeEach(async () => {
        queueName = "test-" + Date.now() + "-" + Math.random().toString(16).substring(2);
        fq = new FairQueue<FairQueuePayload, string>(
            queueName, 
            getRedisConfig(), 
            getRabbitConfig()
        );
        fq.on("error", async (err) => {
            debug("handled error in queue process function", err);
            // await fq.close();
        });
        await fq.init();
    });

    afterEach(async () => {
        if (fq.active) {
            await fq.close();
        }
    });

    afterAll(async () => {
        await Promise.all([
            redisContainer.stop(),
            rabbitmqContainer.stop(),
        ]);
    });

    beforeAll(async () => {});

    afterAll(() => {
        // wtf.dump({ fullStacks: true });
    });

    it("should add a url to the queue", async () => {
        await expect(fq.push(...generateAddRequest("https://example.com"))).resolves.not.toEqual("-1");
        await expect(fq.push(...generateAddRequest("https://example1.com"))).resolves.not.toEqual("-1");
        // duplicate shouldn't be added
        await expect(fq.push(...generateAddRequest("https://example.com"))).resolves.toEqual("-1");
        await expect(fq.push(...generateAddRequest("https://example.com/index.html"))).resolves.not.toEqual("-1");
    });

    it("should return the next url", async () => {
        const payload1 = generateAddRequest("https://example.com");
        const payload2 = generateAddRequest("https://example1.com");
        await expect(fq.push(...payload1)).resolves.not.toEqual("-1");
        await expect(fq.push(...payload1)).resolves.toEqual("-1");
        await expect(fq.push(...payload2)).resolves.not.toEqual("-1");
        await expect(fq.next()).resolves.toMatchObject({ hostname: "example.com", payload: payload1[0] });
        await expect(fq.next()).resolves.toMatchObject({ hostname: "example1.com", payload: payload2[0] });
        await expect(
            Promise.race([fq.next(), new Promise((resolve) => setTimeout(() => resolve("Timed Out"), 1000))])
        ).resolves.toEqual("Timed Out");
    });

    it("should return in proper order push", async () => {
        const payloads = [
            generateAddRequest("https://example.com/"), // 1
            generateAddRequest("https://example1.com/"), // 2
            generateAddRequest("https://example1.com/1"), // 4
            // here we will insert extraPayload "https://example.com/2", 5
            generateAddRequest("https://example1.com/2"), // 6
            generateAddRequest("https://example1.com/3"), // 7
            generateAddRequest("https://example.com/1"),  // 3
        ];
        for (const payload of payloads) {
            await fq.push(...payload);
        }

        const { payloadMsg: payloadMsg1 } = await expectResolvesToMatchObject(fq.next(), { payload: payloads[0][0] });
        const { payloadMsg: payloadMsg2 } = await expectResolvesToMatchObject(fq.next(), { payload: payloads[1][0] });
        await fq.release(payloadMsg1);
        await fq.release(payloadMsg2);
        const { payloadMsg: payloadMsg3 } = await expectResolvesToMatchObject(fq.next(), { payload: payloads[5][0] });
        const { payloadMsg: payloadMsg4 } = await expectResolvesToMatchObject(fq.next(), { payload: payloads[2][0] });
        await fq.release(payloadMsg3);
        await fq.release(payloadMsg4);

        // now order of the push only matters
        const extraPayload = generateAddRequest("https://example.com/2");
        await fq.push(...extraPayload);

        const { payloadMsg: payloadMsg5 } = await expectResolvesToMatchObject(fq.next(), { payload: extraPayload[0] });
        const { payloadMsg: payloadMsg6 } = await expectResolvesToMatchObject(fq.next(), { payload: payloads[3][0] });

        await fq.release(payloadMsg6);
        await fq.release(payloadMsg5);
        await expectResolvesToMatchObject(fq.next(), { payload: payloads[4][0] });
    });

    it("should return in proper order unshift", async () => {
        const payloads = [
            generateAddRequest("https://example.com/"),
            generateAddRequest("https://example1.com/"),
            generateAddRequest("https://example1.com/1"),
            generateAddRequest("https://example1.com/2"),
            generateAddRequest("https://example1.com/3"),
            generateAddRequest("https://example.com/1"),
        ];

        for (const [i, payload] of payloads.entries()) {
            if (i > 3) {
                await fq.unshift(...payload);
            } else {
                await fq.push(...payload);
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));

        // it starts with "https://example.com/1" because that's what is the order in redis list
        // example.com, then example1.com
        const { payloadMsg: payloadMsg1 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example.com", payload: payloads[5][0] });
        await fq.release(payloadMsg1);

        const { payloadMsg: payloadMsg2 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example1.com", payload: payloads[4][0] });
        await fq.release(payloadMsg2);

        const { payloadMsg: payloadMsg3 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example.com", payload: payloads[0][0] });
        await fq.release(payloadMsg3);

        const { payloadMsg: payloadMsg4 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example1.com", payload: payloads[1][0] });
        await fq.release(payloadMsg4);

        const { payloadMsg: payloadMsg5 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example1.com", payload: payloads[2][0] });
        await fq.release(payloadMsg5);

        const { payloadMsg: payloadMsg6 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example1.com", payload: payloads[3][0] });
        await fq.release(payloadMsg6);
    });

    it("should lock if the queue is empty", async () => {
        const payload1 = generateAddRequest("https://example.com");
        const payload2 = generateAddRequest("https://example1.com");
        const payload3 = generateAddRequest("https://example2.com");
        await fq.push(...payload1);
        await fq.push(...payload2);
        await expect(fq.next()).resolves.toMatchObject({ hostname: "example.com", payload: payload1[0], });
        await expect(fq.next()).resolves.toMatchObject({ hostname: "example1.com", payload: payload2[0], });
        const promise = fq.next();
        setTimeout(async () => {
            await fq.push(...payload3);
        }, 1000);
        await expect(promise).resolves.toMatchObject({ hostname: "example2.com", payload: payload3[0], });
    });

    it("should remove a payload from the queue", async () => {
        const payloads = [
            generateAddRequest("https://example.com/"),
            generateAddRequest("https://example1.com/"),
            generateAddRequest("https://example1.com/1"),
            generateAddRequest("https://example1.com/2"),
            generateAddRequest("https://example1.com/3"),
            generateAddRequest("https://example.com/1"),
            generateAddRequest("https://example.com/2"),
        ];
        for (const payload of payloads) {
            await fq.push(...payload);
        }

        await fq.remove(payloads[5][0]); //"https://example.com/1");

        const { payloadMsg: payloadMsg1 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example.com", payload: payloads[0][0] });
        await fq.release(payloadMsg1);

        const { payloadMsg: payloadMsg2 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example1.com", payload: payloads[1][0] });
        await fq.release(payloadMsg2);

        const { payloadMsg: payloadMsg3 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example.com", payload: payloads[6][0] });
        await fq.release(payloadMsg3);

        const { payloadMsg: payloadMsg4 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example1.com", payload: payloads[2][0] });
        await fq.release(payloadMsg4);

        const { payloadMsg: payloadMsg5 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example1.com", payload: payloads[3][0] });
        await fq.release(payloadMsg5);

        const { payloadMsg: payloadMsg6 } = await expectResolvesToMatchObject(fq.next(), { hostname: "example1.com", payload: payloads[4][0] });
        await fq.release(payloadMsg6);

        setTimeout(() => fq.push(...payloads[6]), 500);
        await expect(fq.next()).resolves.toMatchObject({ hostname: "example.com", payload: payloads[6][0] });
    });

    it("process", async () => {
        const now = Date.now(); 
        // jest.useFakeTimers({ doNotFake: ['nextTick', 'setTimeout'] });
        const times: number[] = [];
        const results: FairQueuePayload[] = [];
        try {
            fq.process(2, async (payload: FairQueuePayload) => {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                times.push(new Date().getTime());
                results.push(payload);
                return payload.url;
            });
        } catch (err) {
            console.log(err);
        }

        // processing order should be:
        // 0, 1 (in parallel, different hostnames)
        // 5, 2 (in parallel, different hostnames)
        // 6, 3 (in parallel, different hostnames)
        // 4 (alone)
        const payloads = [
            generateAddRequest("https://example.com/"),   // 0 [0]
            generateAddRequest("https://example1.com/"),  // 1 [1]
            generateAddRequest("https://example1.com/1"), // 3 [2]
            generateAddRequest("https://example1.com/2"), // 5 [3]
            generateAddRequest("https://example1.com/3"), // 6 [4]
            generateAddRequest("https://example.com/1"),  // 2 [5]
            generateAddRequest("https://example.com/2"),  // 4 [6]
        ];

        await Promise.all(payloads.map((payload) => fq.push(...payload)));

        await new Promise((resolve) => setTimeout(resolve, 5500));
        expect(times.length).toEqual(7);
        expect(times[0]).toBeGreaterThanOrEqual(now + 1000); 
        expect(times[0]).toBeLessThanOrEqual(now + 1200);
        expect(times[1]).toBeGreaterThanOrEqual(now + 1000);
        expect(times[1]).toBeLessThanOrEqual(now + 1200); 
        expect(times[2]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[2]).toBeLessThanOrEqual(now + 2200);
        expect(times[3]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[3]).toBeLessThanOrEqual(now + 2200);
        expect(times[4]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[4]).toBeLessThanOrEqual(now + 3200);
        expect(times[5]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[5]).toBeLessThanOrEqual(now + 3200);
        expect(times[6]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[6]).toBeLessThanOrEqual(now + 4200);

        expect(results[0]).toEqual(payloads[0][0]);
        expect(results[1]).toEqual(payloads[1][0]);
        expect(results[2]).toEqual(payloads[5][0]);
        expect(results[3]).toEqual(payloads[2][0]);
        expect(results[4]).toEqual(payloads[6][0]);
        expect(results[5]).toEqual(payloads[3][0]);
        expect(results[6]).toEqual(payloads[4][0]);
    }, 10000);

    it("host limits", async () => {
        const now = Date.now();
        const times: number[] = [];
        const results: FairQueuePayload[] = [];
       
        const payloads = [
            generateAddRequest("https://example1.com/"), // 0
            generateAddRequest("https://example1.com/1"), // 1
            generateAddRequest("https://example1.com/2"), // 2
            generateAddRequest("https://example1.com/3"), // 3
            generateAddRequest("https://example1.com/4"), // 4
            generateAddRequest("https://example1.com/5"), // 5
        ];
        await Promise.all(payloads.map((payload) => fq.push(...payload)));
        try {
            let counter = 0;
            fq.process(12, async (payload: FairQueuePayload) => {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                // we fail the first one to make sure it is not in the results
                if (counter++ === 0) {
                    throw new Error("failed");
                }
                times.push(new Date().getTime());
                results.push(payload);
                return payload.url;
            });
        } catch (err) {
            console.log(err);
        }
        await new Promise((resolve) => setTimeout(resolve, 6500));
        expect(times.length).toEqual(5);
        expect(times[0]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[0]).toBeLessThanOrEqual(now + 2200);
        expect(times[1]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[1]).toBeLessThanOrEqual(now + 3200);
        expect(times[2]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[2]).toBeLessThanOrEqual(now + 4200);
        expect(times[3]).toBeGreaterThanOrEqual(now + 5000);
        expect(times[3]).toBeLessThanOrEqual(now + 5200);
        expect(times[4]).toBeGreaterThanOrEqual(now + 6000);
        expect(times[4]).toBeLessThanOrEqual(now + 6200);

        expect(results[0]).toEqual(payloads[1][0]); // now + 2000
        expect(results[1]).toEqual(payloads[2][0]); // now + 3000
        expect(results[2]).toEqual(payloads[3][0]); // now + 4000
        expect(results[3]).toEqual(payloads[4][0]); // now + 5000
        expect(results[4]).toEqual(payloads[5][0]); // now + 6000
    }, 10000);

    it("host limits recovery", async () => {
        let now = Date.now();
        const times: number[] = [];
        const results: FairQueuePayload[] = [];
        fq.process(100, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            times.push(new Date().getTime());
            results.push(payload);
            return payload.url;
        });

        const payloads = [
            generateAddRequest("https://example1.com/"), // 0
            generateAddRequest("https://example1.com/1"), // 1
            generateAddRequest("https://example1.com/2"), // 2
            generateAddRequest("https://example1.com/3"), // 3
            generateAddRequest("https://example1.com/4"), // 4
            generateAddRequest("https://example1.com/5"), // 5
        ];
        await Promise.all(payloads.map((payload) => fq.push(...payload)));
        await new Promise((resolve) => setTimeout(resolve, 3500));
        await fq.close();
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(times.length).toEqual(4);
        expect(times[0]).toBeGreaterThanOrEqual(now + 1000);
        expect(times[0]).toBeLessThanOrEqual(now + 1200);
        expect(times[1]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[1]).toBeLessThanOrEqual(now + 2200);
        expect(times[2]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[2]).toBeLessThanOrEqual(now + 3200);
        expect(times[3]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[3]).toBeLessThanOrEqual(now + 4200);

        const fq2 = new FairQueue<FairQueuePayload, string>(fq.prefix, getRedisConfig(), getRabbitConfig()).on(
            "error",
            (err) => {
                debug("handled error in queue process function", err);
            }
        );
        await fq2.init();

        now = Date.now();
        fq2.process(100, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            times.push(new Date().getTime());
            results.push(payload);
            return payload.url;
        });
        await new Promise((resolve) => setTimeout(resolve, 3500));
        expect(times.length).toEqual(7);
        expect(times[4]).toBeGreaterThanOrEqual(now + 1000);
        expect(times[4]).toBeLessThanOrEqual(now + 1200);
        expect(times[5]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[5]).toBeLessThanOrEqual(now + 2200);

        expect(results[0]).toEqual(payloads[0][0]); // now + 1000
        expect(results[1]).toEqual(payloads[1][0]); // now + 2000
        expect(results[2]).toEqual(payloads[2][0]); // now + 3000
        expect(results[3]).toEqual(payloads[3][0]); // now + 4000
        expect(results.slice(4).sort()).toEqual([
            payloads[3][0],
            payloads[4][0],
            payloads[5][0]
        ].sort()); // now + 1000

        await fq2.close();
    }, 20000);

    it("host limits with delay", async () => {
        const times: number[] = [];
        const results: FairQueuePayload[] = [];
        try {
            let counter = 0;
            fq.process(100, async (payload: FairQueuePayload) => {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                if (counter++ === 0) {
                    throw new Error("failed");
                }
                times.push(new Date().getTime());
                results.push(payload);
                return payload.url;
            });
        } catch (err) {
            console.log(err);
        }
        const payloads = [
            generateAddRequest("https://example1.com/"), // 0
            generateAddRequest("https://example1.com/1"), // 1
            generateAddRequest("https://example1.com/2"), // 2
            generateAddRequest("https://example1.com/3"), // 3
            generateAddRequest("https://example1.com/4"), // 4
            generateAddRequest("https://example1.com/5"), // 5
        ];
        const now = Date.now();
        await Promise.all(payloads.map((payload, i) => new Promise(resolve => {
            setTimeout(() => {
                fq.push(...payload).then(resolve);
            }, i * 500);
        })));
        await new Promise((resolve) => setTimeout(resolve, 6500));
        expect(times.length).toEqual(5);
        expect(times[0]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[0]).toBeLessThanOrEqual(now + 2200);
        expect(times[1]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[1]).toBeLessThanOrEqual(now + 3200);
        expect(times[2]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[2]).toBeLessThanOrEqual(now + 4200);
        expect(times[3]).toBeGreaterThanOrEqual(now + 5000);
        expect(times[3]).toBeLessThanOrEqual(now + 5200);
        expect(times[4]).toBeGreaterThanOrEqual(now + 6000);
        expect(times[4]).toBeLessThanOrEqual(now + 6200);

        expect(results[0]).toEqual(payloads[1][0]); // now + 2000
        expect(results[1]).toEqual(payloads[2][0]); // now + 3000
        expect(results[2]).toEqual(payloads[3][0]); // now + 4000
        expect(results[3]).toEqual(payloads[4][0]); // now + 5000
        expect(results[4]).toEqual(payloads[5][0]); // now + 6000
    }, 10000);

    it("host limits parallel, multiple queues", async () => {
        const now = Date.now();
        const times: number[] = [];
        const results: FairQueuePayload[] = [];

        const payloads = [
            generateAddRequest("https://example1.com/"), // 0
            generateAddRequest("https://example1.com/1"), // 1
            generateAddRequest("https://example1.com/2"), // 2
            generateAddRequest("https://example1.com/3"), // 3
            generateAddRequest("https://example1.com/4"), // 4
            generateAddRequest("https://example1.com/5"), // 5
        ];
        const fqs = [];
        const prefix = fq.prefix;
        for (let i = 0; i < payloads.length * 2; i++) {
            const fq = new FairQueue<FairQueuePayload, string>(prefix, getRedisConfig(), getRabbitConfig()).on(
                "error",
                (err) => {
                    debug("handled error in queue process function", err);
                }
            );
            await fq.init();
            fqs.push(fq);
        }

        fqs.forEach((fq) => {
            fq.process(100, async (payload: FairQueuePayload) => {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                times.push(new Date().getTime());
                results.push(payload);
                return payload.url;
            });
        });

        await Promise.all(payloads.map((payload) => fq.push(...payload)));
        // await Promise.all(payloads.map((payload, i) => new Promise(resolve => {
        //     setTimeout(() => {
        //         fq.push(...payload).then(resolve);
        //     }, i * 500);
        // })));
        await new Promise((resolve) => setTimeout(resolve, 6500));
        expect(times.length).toEqual(payloads.length);
        expect(times[0]).toBeGreaterThanOrEqual(now + 1000);
        expect(times[0]).toBeLessThanOrEqual(now + 1400);
        expect(times[1]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[1]).toBeLessThanOrEqual(now + 2400);
        expect(times[2]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[2]).toBeLessThanOrEqual(now + 3400);
        expect(times[3]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[3]).toBeLessThanOrEqual(now + 4400);
        expect(times[4]).toBeGreaterThanOrEqual(now + 5000);
        expect(times[4]).toBeLessThanOrEqual(now + 5400);
        expect(times[5]).toBeGreaterThanOrEqual(now + 6000);
        expect(times[5]).toBeLessThanOrEqual(now + 6400);

        expect(results[0]).toEqual(payloads[0][0]); // now + 1000
        expect(results[1]).toEqual(payloads[1][0]); // now + 2000
        expect(results[2]).toEqual(payloads[2][0]); // now + 3000
        expect(results[3]).toEqual(payloads[3][0]); // now + 4000
        expect(results[4]).toEqual(payloads[4][0]); // now + 5000
        expect(results[5]).toEqual(payloads[5][0]); // now + 6000

        await Promise.all(fqs.map((fq) => fq.close()));
    }, 10000);

    it("per host concurrency increase", async () => {
        const now = Date.now();
        const times: number[] = [];
        const results: FairQueuePayload[] = [];
        fq.process(2, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // should never finish
            times.push(new Date().getTime());
            results.push(payload);
            return payload.url;
        });

        const payloads = [
            generateAddRequest("https://example.com/", 2), // 0
            generateAddRequest("https://example.com/1", 2), // 1
            generateAddRequest("https://example.com/2", 2), // 2
            generateAddRequest("https://example.com/3", 2), // 3
            generateAddRequest("https://example.com/4", 2), // 4
            generateAddRequest("https://example1.com/"), // 5
            generateAddRequest("https://example1.com/1"), // 6
            generateAddRequest("https://example1.com/2"), // 7
            generateAddRequest("https://example1.com/3"), // 8
        ];
        await Promise.all(payloads.map((payload) => fq.push(...payload)));
        await new Promise((resolve) => setTimeout(resolve, 4500));
        expect(times.length).toEqual(8);
        expect(times[0]).toBeGreaterThanOrEqual(now + 1000);
        expect(times[0]).toBeLessThanOrEqual(now + 1200);
        expect(times[1]).toBeGreaterThanOrEqual(now + 1000);
        expect(times[1]).toBeLessThanOrEqual(now + 1200);
        expect(times[2]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[2]).toBeLessThanOrEqual(now + 2200);
        expect(times[3]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[3]).toBeLessThanOrEqual(now + 2200);
        expect(times[4]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[4]).toBeLessThanOrEqual(now + 3200);
        expect(times[5]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[5]).toBeLessThanOrEqual(now + 3200);
        expect(times[6]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[6]).toBeLessThanOrEqual(now + 4200);
        expect(times[7]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[7]).toBeLessThanOrEqual(now + 4200);

        // the logics of round robin is:
        // example.com example.com example1.com
        // example.com example.com example1.com
        expect(results[0]).toEqual(payloads[0][0]); // 'https://example.com/'
        expect(results[1]).toEqual(payloads[1][0]); // 'https://example.com/1' parallel with previous
        expect(results[2]).toEqual(payloads[5][0]); // 'https://example1.com/'
        expect(results[3]).toEqual(payloads[2][0]); // 'https://example.com/2' parallel with previous
        expect(results[4]).toEqual(payloads[3][0]); // 'https://example.com/3'
        expect(results[5]).toEqual(payloads[6][0]); // 'https://example1.com/1' parallel with previous
        expect(results[6]).toEqual(payloads[4][0]); // 'https://example.com/4'
        expect(results[7]).toEqual(payloads[7][0]); // 'https://example1.com/2' parallel with previous
    }, 10000);

    it("per host concurrency decrease", async () => {
        const now = Date.now();
        const times: number[] = [];
        const results: FairQueuePayload[] = [];
        fq.process(2, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // should never finish
            times.push(new Date().getTime());
            results.push(payload);
            return payload.url;
        });

        const payloads = [
            generateAddRequest("https://example.com/", 2), // 0
            generateAddRequest("https://example.com/1", 2), // 1
            generateAddRequest("https://example1.com/"), // 5
            generateAddRequest("https://example.com/2", 2), // 2
        ];
        await Promise.all(payloads.map((payload) => fq.push(...payload)));
        await new Promise((resolve) => setTimeout(resolve, 500)); // let the first 2 begin, but not finish

        const resetConcurrencyPayloads = [
            generateAddRequest("https://example.com/3", 1), // 3
            generateAddRequest("https://example.com/4", 1), // 4
            generateAddRequest("https://example1.com/1"), // 6
            generateAddRequest("https://example1.com/2"), // 7
        ];
        await Promise.all(resetConcurrencyPayloads.map((payload) => fq.push(...payload)));
        await new Promise((resolve) => setTimeout(resolve, 4000));

        expect(times.length).toEqual(8);
        expect(times[0]).toBeGreaterThanOrEqual(now + 1000);
        expect(times[0]).toBeLessThanOrEqual(now + 1200);
        expect(times[1]).toBeGreaterThanOrEqual(now + 1000);
        expect(times[1]).toBeLessThanOrEqual(now + 1200);
        expect(times[2]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[2]).toBeLessThanOrEqual(now + 2200);
        expect(times[3]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[3]).toBeLessThanOrEqual(now + 2200);
        expect(times[4]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[4]).toBeLessThanOrEqual(now + 3200);
        expect(times[5]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[5]).toBeLessThanOrEqual(now + 3200);
        expect(times[6]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[6]).toBeLessThanOrEqual(now + 4200);
        expect(times[7]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[7]).toBeLessThanOrEqual(now + 4200);

        // the logics of round robin is:
        // example.com example.com example1.com
        // example.com example.com example1.com
        expect(results[0]).toEqual(payloads[0][0]); // 'https://example.com/'
        expect(results[1]).toEqual(payloads[1][0]); // 'https://example.com/1' parallel with previous
        expect(results[2]).toEqual(payloads[2][0]); // 'https://example1.com/'
        expect(results[3]).toEqual(payloads[3][0]); // 'https://example.com/2' parallel with previous
        expect(results[4]).toEqual(resetConcurrencyPayloads[0][0]); // 'https://example.com/3'  parallel with previous
        expect(results[5]).toEqual(resetConcurrencyPayloads[2][0]); // 'https://example1.com/1'
        expect(results[6]).toEqual(resetConcurrencyPayloads[1][0]); // 'https://example.com/4'
        expect(results[7]).toEqual(resetConcurrencyPayloads[3][0]); // 'https://example1.com/2' parallel with previous
    }, 10000);

    // it("stats", async () => {
    //     const payloads = [
    //         generateAddRequest("https://example.com/", 4),
    //         generateAddRequest("https://example1.com/", 4),
    //         generateAddRequest("https://example1.com/1", 4),
    //         generateAddRequest("https://example1.com/2", 4),
    //         generateAddRequest("https://example1.com/3", 4),
    //         generateAddRequest("https://example.com/1", 4),
    //         generateAddRequest("https://example.com/2", 4),
    //     ];
    //     for (const payload of payloads) {
    //         await fq.push(...payload);
    //     }

    //     // this is for concurrency 1
    //     // await expect(fq.stats()).resolves.toEqual({ pending: 0, total: 2 });
    //     // await expect(fq.stats('example.com')).resolves.toEqual({ pending: 0, total: 1, urls: 3 });
    //     // await expect(fq.stats('example1.com')).resolves.toEqual({ pending: 0, total: 1, urls: 4 });

    //     // this is for concurrency 4 for each host
    //     await expect(fq.stats()).resolves.toEqual({ pending: 0, total: 7, urls: 7 });
    //     await expect(fq.stats("example.com")).resolves.toEqual({ pending: 0, total: 3, urls: 3 });
    //     await expect(fq.stats("example1.com")).resolves.toEqual({ pending: 0, total: 4, urls: 4 });
    //     await expect(fq.queuedHosts()).resolves.toEqual([
    //         "example.com",
    //         "example1.com",
    //         "example1.com",
    //         "example1.com",
    //         "example1.com",
    //         "example.com",
    //         "example.com",
    //     ]);
    //     await expect(fq.queuedHosts(true)).resolves.toEqual({
    //         "example.com": 3,
    //         "example1.com": 4,
    //     });
    //     await expect(fq.pendingHosts()).resolves.toEqual([]);

    //     fq.process(8, async () => {
    //         await new Promise((resolve) => setTimeout(resolve, 1000)); // should never finish
    //         return;
    //     });

    //     await new Promise((resolve) => setTimeout(resolve, 500));

    //     await expect(fq.stats()).resolves.toEqual({ pending: 7, total: 7, urls: 7 });
    //     await expect(fq.stats("example.com")).resolves.toEqual({ pending: 3, total: 3, urls: 0 });
    //     await expect(fq.stats("example1.com")).resolves.toEqual({ pending: 4, total: 4, urls: 0 });
    //     await expect(fq.queuedHosts()).resolves.toEqual([]);
    //     await expect(fq.pendingHosts()).resolves.toEqual([
    //         "example.com",
    //         "example1.com",
    //         "example1.com",
    //         "example1.com",
    //         "example1.com",
    //         "example.com",
    //         "example.com",
    //     ]);
    //     await expect(fq.pendingHosts(true)).resolves.toEqual({
    //         "example.com": 3,
    //         "example1.com": 4,
    //     });
    // });

    // it("position in queue 1", async () => {
    //     const payloads = [
    //         generateAddRequest("https://example.com/", 1),
    //         generateAddRequest("https://example1.com/", 1),
    //         generateAddRequest("https://example1.com/1", 1),
    //         generateAddRequest("https://example1.com/2", 1),
    //         generateAddRequest("https://example1.com/3", 1),
    //         generateAddRequest("https://example.com/1", 1),
    //         generateAddRequest("https://example.com/2", 1),
    //     ];
    //     for (const payload of payloads) {
    //         await fq.push(...payload);
    //     }

    //     await expect(fq.urlPositionInQueue("https://example.com/")).resolves.toEqual(0);
    //     await expect(fq.urlPositionInQueue("https://example1.com/")).resolves.toEqual(1);
    //     await expect(fq.urlPositionInQueue("https://example.com/1")).resolves.toEqual(2);
    //     await expect(fq.urlPositionInQueue("https://example1.com/1")).resolves.toEqual(3);
    //     await expect(fq.urlPositionInQueue("https://example.com/2")).resolves.toEqual(4);
    //     await expect(fq.urlPositionInQueue("https://example1.com/2")).resolves.toEqual(5);
    //     await expect(fq.urlPositionInQueue("https://example1.com/3")).resolves.toEqual(6);
    //     await expect(fq.urlPositionInQueue("https://example1.com/4")).resolves.toEqual(-1);
    //     await expect(fq.urlPositionInQueue("https://example.com/4")).resolves.toEqual(-1);
    //     await expect(fq.urlPositionInQueue("https://example2.com/")).resolves.toEqual(-1);
    // });

    // it("position in queue 2", async () => {
    //     const payloads = [
    //         generateAddRequest("https://example.com/", 4),
    //         generateAddRequest("https://example1.com/", 1),
    //         generateAddRequest("https://example1.com/1", 1),
    //         generateAddRequest("https://example1.com/2", 1),
    //         generateAddRequest("https://example1.com/3", 1),
    //         generateAddRequest("https://example.com/1", 4),
    //         generateAddRequest("https://example.com/2", 4),
    //     ];
    //     for (const payload of payloads) {
    //         await fq.push(...payload);
    //     }

    //     await expect(fq.urlPositionInQueue("https://example.com/")).resolves.toEqual(0);
    //     await expect(fq.urlPositionInQueue("https://example1.com/")).resolves.toEqual(1);
    //     await expect(fq.urlPositionInQueue("https://example.com/1")).resolves.toEqual(2);
    //     await expect(fq.urlPositionInQueue("https://example.com/2")).resolves.toEqual(3);
    //     await expect(fq.urlPositionInQueue("https://example1.com/1")).resolves.toEqual(4);
    //     await expect(fq.urlPositionInQueue("https://example1.com/2")).resolves.toEqual(5);
    //     await expect(fq.urlPositionInQueue("https://example1.com/3")).resolves.toEqual(6);
    //     await expect(fq.urlPositionInQueue("https://example1.com/4")).resolves.toEqual(-1);
    //     await expect(fq.urlPositionInQueue("https://example.com/4")).resolves.toEqual(-1);
    //     await expect(fq.urlPositionInQueue("https://example2.com/")).resolves.toEqual(-1);
    // });

    it("purge", async () => {
        const payloads = [
            generateAddRequest("https://example.com/", 4),
            generateAddRequest("https://example1.com/", 1),
            generateAddRequest("https://example1.com/1", 1),
            generateAddRequest("https://example1.com/2", 1),
            generateAddRequest("https://example1.com/3", 1),
            generateAddRequest("https://example.com/1", 4),
            generateAddRequest("https://example.com/2", 4),
        ];

        for (const payload of payloads) {
            await fq.push(...payload);
        }

        await fq.purge("https://example.com/");
        fq.process(100, async () => {
            throw new Error("should not be called");
        });
    });

    it("recovery from failure", async () => {
        const payloads = [
            generateAddRequest("https://example.com/", 20),
            generateAddRequest("https://example1.com/", 20),
            generateAddRequest("https://example1.com/1", 20),
            generateAddRequest("https://example1.com/2", 20),
            generateAddRequest("https://example1.com/3", 20),
            generateAddRequest("https://example.com/1", 20),
            generateAddRequest("https://example.com/2", 20),
        ];
        for (const payload of payloads) {
            await fq.push(...payload);
        }

        // lets consume all the urls, and don't finish them
        const urls: string[] = [];

        const ab = new AbortController();
        fq.process(100, async (payload: FairQueuePayload) => {
            urls.push(payload.url);
            await new Promise<void>((resolve) => { 
                const onAbort = () => {
                    ab.signal.removeEventListener("abort", onAbort);
                    resolve();
                };
                ab.signal.addEventListener("abort", onAbort);
            });
            return payload.url;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await fq.close();

        // no hosts were returned from the pending queue yet
        const fq2 = new FairQueue<FairQueuePayload, string>(fq.prefix, getRedisConfig(), getRabbitConfig()).on(
            "error",
            (err) => {
                debug("handled error in queue process function", err);
            }
        );
        await fq2.init();
        fq2.process(100, async (payload: FairQueuePayload) => {
            urls.push(payload.url);
            return payload.url;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await fq2.close();
        ab.abort();

        expect(urls.length).toEqual(payloads.length * 2); 
        // expect(urls.slice(0, payloads.length)).toEqual([
        expect(urls).toEqual([
            "https://example.com/",
            "https://example1.com/",
            "https://example1.com/1",
            "https://example1.com/2",
            "https://example1.com/3",
            "https://example.com/1",
            "https://example.com/2",
            // -- fq2
            "https://example.com/",
            "https://example.com/1",  // <--
            "https://example1.com/",  //   |
            "https://example1.com/1", //   |
            "https://example1.com/2", //   |
            "https://example1.com/3", //   |
            //                           ---
            "https://example.com/2",
        ]);
    });

    it("should distribute jobs across multiple queues in a loop", async () => {
        const numQueues = 3;
        const numIterations = 10;

        const prefix = fq.prefix;
        for (let iteration = 0; iteration < numIterations; iteration++) {
            const queues = [];
            const jobsPerQueue = new Array(numQueues + 1).fill(0);
            const queueName = `${prefix}-${iteration}`;

            const fq = new FairQueue<FairQueuePayload, string>(queueName, getRedisConfig(), getRabbitConfig()).on(
                "error",
                (err) => {
                    debug("handled error in queue process function", err);
                }
            );
            await fq.init();

            // Create multiple FairQueue instances
            for (let i = 0; i < numQueues; i++) {
                const fqInstance = new FairQueue(queueName, getRedisConfig(), getRabbitConfig()).on("error", (err) => {
                    console.log("caught error", err);
                });
                await fqInstance.init();
                queues.push(fqInstance);
            }

            let timeout = 100;
            queues.forEach((fqInstance, index) => {
                // in the worst case scenario it should take 10s to process all jobs
                // if all of them have the same hostname
                // in the best case scenario it should take 2s to process all jobs evenly across 5 hosts
                // if we set here 10ms, then the worst case scenario is 1s
                // if we set here 100ms, then the best case scenario is 0.2s, which might not be enough to
                // for the 4th queue to wake up and grab any jobs
                fqInstance.process(10, async () => {
                    await new Promise((resolve) => setTimeout(resolve, timeout)); // + Math.floor(Math.random() * 100)));
                    jobsPerQueue[index]++;
                });
            });

            // Enqueue multiple jobs using the 'fq' instance from beforeEach
            const numJobs = 100;
            const payloads: Array<GeneratedPayload> = [];
            for (let i = 0; i < numJobs; i++) {
                // Randomly choose hostnames to introduce randomness
                const hostIndex = Math.floor(Math.random() * 5);
                const url = `https://example${hostIndex}.com/page${i}`;
                payloads.push(generateAddRequest(url));
            }
            // we should wait for confirm in test, so 
            const jobIds = await Promise.all(payloads.map((payload) => fq.push(...payload)));
            expect(jobIds.length).toBe(numJobs);

            const fqInstance = new FairQueue(queueName, getRedisConfig(), getRabbitConfig()).on("error", (err) => {
                console.log("caught error", err);
            });
            await fqInstance.init();
            queues.push(fqInstance);

            fqInstance.process(10, async () => {
                timeout = 10; // to speed up the other queues
                // Simulate some processing time
                await new Promise((resolve) => setTimeout(resolve, timeout));
                jobsPerQueue[numQueues]++;
            });

            const startTime = Date.now();
            await new Promise<void>((resolve) => {
                const checkInterval = setInterval(() => {
                    const total = jobsPerQueue.reduce((acc, count) => acc + count, 0);
                    if (Date.now() - startTime > 5000) {
                        console.log(`Iteration ${iteration}: ${total}`, jobsPerQueue, Date.now() - startTime);
                    }
                    if (total >= numJobs || Date.now() - startTime > 15000) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 500);
            });
            // await new Promise((resolve) => setTimeout(resolve, 3000));

            // Close all queues before asserts
            await Promise.all(queues.map((fqInstance) => fqInstance.close()));
            await fq.close();

            // Check that each queue processed at least one job
            const queuesWithJobs = jobsPerQueue.filter((count) => count > 0).length;
            // console.log(`Iteration ${iteration}, Queues with jobs: ${queuesWithJobs}, Jobs per queue: ${jobsPerQueue}`);
            expect(queuesWithJobs).toBe(numQueues + 1);
            // during wake up, some of the jobs will be requeued
            expect(jobsPerQueue.reduce((acc, count) => acc + count, 0)).toBeGreaterThanOrEqual(numJobs);
        }
    }, 60000);

    it("should distribute jobs evenly when number of hosts < number of processors", async () => {
        const numQueues = 6; // processors
        const hosts = ["example1.com", "example2.com", "example3.com"];
        const numHosts = hosts.length;  // hosts
        const urlsPerHost = 100;
        const queueName = fq.prefix + "-distribution";

        const queues = [];
        const jobsPerQueue = new Array(numQueues).fill(0);

        // Main queue for adding jobs
        const fq2 = new FairQueue(queueName, getRedisConfig(), getRabbitConfig())
            .on("error", (err) => console.log("caught error", err));
        await fq2.init();

        // Add 100 URLs for each host
        const payloads: Array<GeneratedPayload> = [];

        hosts.forEach(hostname => {
            for (let i = 0; i < urlsPerHost; i++) {
                const url = `https://${hostname}/page${i}`;
                payloads.push(generateAddRequest(url));
            }
        });

        // Create multiple processor instances
        // after the queue has
        for (let i = 0; i < numQueues; i++) {
            const fqInstance = new FairQueue(queueName, getRedisConfig(), getRabbitConfig())
                .on("error", (err) => console.log("caught error", err));
            await fqInstance.init();
            fqInstance.process(10, async () => {
                jobsPerQueue[i]++;
                // Fixed processing time to eliminate timing variance
                await new Promise((resolve) => setTimeout(resolve, 10)); // + Math.floor(Math.random() * 300)));
            });
            queues.push(fqInstance);
        }

        // Add all jobs
        await Promise.all(payloads.map((payload) => fq2.push(...payload)));

        // Wait for processing to complete (100ms per job + buffer)
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close all queues
        await Promise.all([...queues, fq2].map(q => q.close()));

        // Verify distribution
        const totalJobs = jobsPerQueue.reduce((sum, count) => sum + count, 0);
        const expectedJobsPerQueue = Math.floor(totalJobs / numQueues);
        const margin = expectedJobsPerQueue * 0.2; // Allow 20% variance

        // Each queue should handle roughly the same number of jobs
        jobsPerQueue.forEach((count) => {
            expect(count).toBeGreaterThanOrEqual(expectedJobsPerQueue - margin);
            expect(count).toBeLessThanOrEqual(expectedJobsPerQueue + margin);
        });

        // Total jobs should match input
        expect(totalJobs).toBe(numHosts * urlsPerHost);
    }, 60000);

    it("leaks a pending host when a worker dies mid–job", async () => {

        const fq2 = new FairQueue(fq.prefix, getRedisConfig(), getRabbitConfig()).on("error", (err) => {
            console.log("caught error", err);
        });
        const fq3 = new FairQueue(fq.prefix, getRedisConfig(), getRabbitConfig()).on("error", (err) => {
            console.log("caught error", err);
        });
        const fq4 = new FairQueue(fq.prefix, getRedisConfig(), getRabbitConfig()).on("error", (err) => {
            console.log("caught error", err);
        });
        await fq2.init();

        fq.process(1, async () => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return "";
        });

        fq2.process(1, async () => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
        });

        await fq.push(...generateAddRequest("https://example1.com/"));
        await fq.push(...generateAddRequest("https://example2.com/"));
        await fq.push(...generateAddRequest("https://example3.com/"));
        await fq.push(...generateAddRequest("https://example4.com/"));

        await expect(fq.stats()).resolves.toEqual({ pending: 2, total: 4, urls: 4 });
        await fq.close();
        await fq2.close();

        await fq3.init();
        await fq4.init();

        fq3.process(1, async ()=> {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });

        fq4.process(1, async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });
        await new Promise((resolve) => setTimeout(resolve, 500));

        const errors: Error[] = [];

        try {
            await expect(fq3.stats()).resolves.toEqual({ pending: 2, total: 4, urls: 4 });
        } catch (err) {
            errors.push(err as Error);
        }
        
        await fq2.close();
        await fq3.close();
        await fq4.close();
        // let's wait for fq3 and fq4 to finish processing before ending the test
        await new Promise((resolve) => setTimeout(resolve, 1500)); // (fq 2000 - 500)

        if (errors.length) {
            throw errors[0];
        }
    });

    // it("duplicated host after parallel wakeUps on the same machineId", async () => {
    //     // 1. Arrange – host is in pending-hosts + pending-payloads
    //     const payload = generateAddRequest("https://dup-example.com/");
    //     await fq.push(...payload);
    //     const { hostname } = await fq.next(); // host in pending
    //     // await fq.blockingRedis.disconnect(); // stop the worker, no release()

    //     // 2. Spin up four processes that share hostname ⇒ same machineId
    //     const procs: FairQueue<FairQueuePayload>[] = [];
    //     for (let i = 0; i < 4; i++) {
    //         procs.push(new FairQueue<FairQueuePayload>("test", { redis: { host, port } }));
    //     }
    //     await Promise.all(procs.map((p) => p.wakeUp()));

    //     // 3. There must be **≤1** copy of the host across main+pending
    //     const [main, pending] = await Promise.all([
    //         redisClient.lrange(`${FAIR_QUEUE_NAME}:test`, 0, -1),
    //         redisClient.lrange(`${FAIR_QUEUE_NAME}:test:pending-hosts`, 0, -1),
    //     ]);
    //     const total = [...main, ...pending].filter((h) => h === hostname).length;
    //     expect(total).toBe(1); // fails → got 2

    //     await Promise.all(procs.map((p) => p.close()));
    // });

    // it("no duplicate pending hosts when two releases race", async () => {
    //     // concurrency = 1, but we queue three payloads so two workers can race
    //     const hostUrl = "https://race-example.com/";
    //     await fq.push(...generateAddRequest(hostUrl + "1", 2));
    //     await fq.push(...generateAddRequest(hostUrl + "2", 2));
    //     await fq.push(...generateAddRequest(hostUrl + "3", 2));

    //     // Two independent workers on the same host (same machineId)
    //     const worker1 = new FairQueue("test", { redis: { host, port } });
    //     const worker2 = new FairQueue("test", { redis: { host, port } });

    //     const barrier: (() => void)[] = [];
    //     const wait = () => new Promise<void>((resolve) => barrier.push(resolve));

    //     for (const w of [worker1, worker2]) {
    //         w.process(1, async () => {
    //             await wait(); // both workers finish together
    //         });
    //     }

    //     // Let both next()/processing finish and hit the barrier…
    //     await new Promise((res) => setTimeout(res, 200));

    //     let queuedHosts, pendingHosts;
    //     queuedHosts = (await worker1.queuedHosts(true)) as Record<string, number>;
    //     pendingHosts = (await worker1.pendingHosts(true)) as Record<string, number>;
    //     barrier.forEach((resolve) => resolve());
    //     // …then allow release() to run
    //     await new Promise((res) => setTimeout(res, 200));
    //     queuedHosts = (await worker1.queuedHosts(true)) as Record<string, number>;
    //     pendingHosts = (await worker1.pendingHosts(true)) as Record<string, number>;

    //     expect(queuedHosts["race-example.com"]).toBeUndefined();
    //     expect(pendingHosts["race-example.com"]).toBe(1);
    //     barrier.forEach((resolve) => resolve());

    //     await Promise.all([worker1.close(), worker2.close()]);
    // });
    it("sync push good", async () => {
        fq.process(10, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return payload.url;
        });
        const fq2 = new FairQueue<FairQueuePayload, string>(fq.prefix, getRedisConfig(), getRabbitConfig()).on(
            "error",
            (err) => {
                debug("handled error in queue process function", err);
            }
        );
        await fq2.init();

        const request = generateAddRequest("https://sync1.com/");
        const payload = request[0];
        const correlationId = await fq2.push(...request);
        await new Promise((resolve) => setTimeout(resolve, 500));
        // console.log("waiting for result with correlationId", correlationId);
        const errors: Error[] = [];
        try {
            await expect(fq.waitFor(correlationId)).resolves.toEqual({ eventType: "success", payload, result: "https://sync1.com/" });
        } catch (err) {
            errors.push(err as Error);
        }
        
        await fq2.close();
        if (errors.length) {
            throw errors[0];
        }
    });

    it("sync push error", async () => {
        fq.process(10, async () => {
            throw new Error("Processing failed");
        });
        const fq2 = new FairQueue<FairQueuePayload, string>(fq.prefix, getRedisConfig(), getRabbitConfig()).on(
            "error",
            (err) => {
                debug("handled error in queue process function", err);
            }
        );
        await fq2.init();

        const request = generateAddRequest("https://sync1.com/");
        const payload = request[0];
        // console.log("pushing", request);
        const correlationId = await fq2.push(...request);
        // console.log("waiting for result with correlationId", correlationId);
        const errors: Error[] = [];
        try {
            await expect(fq.waitFor(correlationId)).resolves.toMatchObject({
                eventType: "error",
                payload,
                error: { name: "Error", message: "Processing failed" },
            });
        } catch (err) {
            errors.push(err as Error);
        }
        await fq2.close();
        if (errors.length) {
            throw errors[0];
        }
    });

    it("sync push timeout", async () => {
        fq.process(10, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return payload.url;
        });
        const fq2 = new FairQueue<FairQueuePayload, string>(fq.prefix, getRedisConfig(), getRabbitConfig()).on(
            "error",
            (err) => {
                debug("handled error in queue process function", err);
            }
        );
        await fq2.init();

        const correlationId = await fq2.push(...generateAddRequest("https://sync1.com/"));
        let errors: Error[] = [];
        try {
            await expect(fq.waitFor(correlationId, { timeoutMs: 100 })).rejects.toThrow("Timeout");
        } catch (err) {
            errors.push(err as Error);
        }
        await fq2.close();
        if (errors.length) {
            throw errors[0];
        }

    });
    it("sync push abort", async () => {
        fq.process(10, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return payload.url;
        });
        const fq2 = new FairQueue<FairQueuePayload, string>(fq.prefix, getRedisConfig(), getRabbitConfig()).on(
            "error",
            (err) => {
                debug("handled error in queue process function", err);
            }
        );
        await fq2.init();

        const ac = new AbortController();
        const correlationId = await fq2.push(...generateAddRequest("https://sync1.com/"));
        setTimeout(() => ac.abort(), 100);
        let errors: Error[] = [];
        try {
            await expect(fq.waitFor(correlationId, { signal: ac.signal })).rejects.toThrow("Aborted");
        } catch (err) {
            errors.push(err as Error);
        }
        await fq2.close();
        if (errors.length) {
            throw errors[0];
        }
    });

    it("should reject push when maxUrlQueueLength is exceeded", async () => {
        // Close the default queue to create a new one with custom settings
        await fq.close();

        // Create a new queue with very small maxUrlQueueLength
        const fqWithLimit = new FairQueue<FairQueuePayload, string>(queueName + "-limit", getRedisConfig(), {
            ...getRabbitConfig(),
            maxUrlQueueLength: 2, // Very small limit for testing
        });

        let errorOccurred = false;
        fqWithLimit.on("error", (err) => {
            debug("handled error in queue with max length limit", err);
            errorOccurred = true;
        });

        await fqWithLimit.init();

        try {
            // Push first URL - should succeed
            const correlationId1 = await fqWithLimit.push(...generateAddRequest("https://example.com/1"));
            expect(correlationId1).not.toEqual("-1");

            // Push second URL - should succeed
            const correlationId2 = await fqWithLimit.push(...generateAddRequest("https://example.com/2"));
            expect(correlationId2).not.toEqual("-1");

            // Push third URL - should fail due to maxLength limit
            await expect(fqWithLimit.push(...generateAddRequest("https://example.com/3"))).rejects.toThrow(
                "Queue is full, message dropped"
            );
        } finally {
            await fqWithLimit.close();
        }

        // Verify that an error was emitted during the failed push
        expect(errorOccurred).toBe(false); // The error should be thrown, not just emitted
    });
});
