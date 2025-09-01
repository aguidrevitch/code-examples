import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "@jest/globals";
import { RedisMemoryServer } from "redis-memory-server";
import { FairQueue, FairQueuePayload } from "../src/index.mjs";
import { Redis } from "ioredis";
import Debug from "debug";
import { FAIR_QUEUE_NAME } from "../src/lib/constants.mjs";
import crypto from "crypto";
import { LUA_CONCURRENCY, LUA_NEXT, LUA_PUSH, LUA_RELEASE, LUA_REMOVE, LUA_UNSHIFT } from "../src/lib/lua.mjs";
// import wtf from "wtfnode";
// wtf.init();

const debug = Debug("test");

type GeneratedPayload = [url: string, payload: FairQueuePayload, concurrency: number | undefined];

const CODE: Record<string, string> = {
    [LUA_UNSHIFT]: "LUA_UNSHIFT",
    [LUA_PUSH]: "LUA_PUSH",
    [LUA_NEXT]: "LUA_NEXT",
    [LUA_REMOVE]: "LUA_REMOVE",
    [LUA_RELEASE]: "LUA_RELEASE",
    [LUA_CONCURRENCY]: "LUA_CONCURRENCY",
};

const SHA1 = {
    [crypto.createHash("sha1").update(LUA_UNSHIFT).digest("hex")]: "LUA_UNSHIFT",
    [crypto.createHash("sha1").update(LUA_PUSH).digest("hex")]: "LUA_PUSH",
    [crypto.createHash("sha1").update(LUA_NEXT).digest("hex")]: "LUA_NEXT",
    [crypto.createHash("sha1").update(LUA_REMOVE).digest("hex")]: "LUA_REMOVE",
    [crypto.createHash("sha1").update(LUA_RELEASE).digest("hex")]: "LUA_RELEASE",
    [crypto.createHash("sha1").update(LUA_CONCURRENCY).digest("hex")]: "LUA_CONCURRENCY",
};

const generateAddRequest = (url: string, concurrency?: number): GeneratedPayload => {
    return [
        url,
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

// class Deferred<T> {
//     promise: Promise<T>;
//     resolve!: ((value: T | PromiseLike<T>) => void);
//     reject!: ((err: Error) => void);
//     isResolved: boolean;
//     constructor() {
//         this.isResolved = false;
//         this.promise = new Promise((resolve, reject) => {
//             this.reject = reject;
//             this.resolve = resolve;
//         });
//         this.promise.then(() => this.isResolved = true);
//     }
// }

describe("FairQueue", () => {

    let redisServer: RedisMemoryServer,
        host: string,
        port: number,
        // debugRedis: Redis,
        redisClient: Redis,
        monitor: Redis,
        fq: FairQueue<FairQueuePayload>;

    beforeEach(async () => {
        redisServer = await RedisMemoryServer.create();
        host = await redisServer.getHost();
        port = await redisServer.getPort();
        fq = new FairQueue<FairQueuePayload>("test", { redis: { host, port } }).on("error", (err) => {
            debug("handled error in queue process function", err);
        });
        // debugRedis = new Redis({ host, port });
        // await debugRedis.subscribe("log");
        // debugRedis.on("message", (channel, message) => debug(message));
        redisClient = new Redis({ host, port });
        await new Promise<void>((resolve, reject) => {
            redisClient.monitor((err, realMonitor) => {
                if (err) {
                    reject(err);
                    return;
                }
                if (!realMonitor) {
                    reject(new Error("Monitor is not available"));
                    return;
                }
                monitor = realMonitor;
                monitor.on("monitor", (time, args) => {
                    if (args[0] === "eval") {
                        const code = args[1].replace(/\\n/g, "\n");
                        const scriptName = CODE[code];
                        if (scriptName) {
                            debug("   ", "eval", scriptName, args.slice(3));
                        } else {
                            debug("   ", ...args);
                        }
                        return;
                    }

                    if (args[0] === "evalsha") {
                        // let's figure out which script is being executed
                        const scriptName = SHA1[args[1]];
                        if (scriptName) {
                            debug("   ", "evalsha", scriptName, args.slice(3));
                        } else {
                            debug("   ", ...args);
                        }
                        return;
                    }

                    if (args[0] === "PUBLISH") {
                        debug("   ", "log", ...args.slice(2));
                    }

                    if (args[0] === "blmove") {
                        debug("   ", ...args);
                    }
                });
                resolve();
            });
        });
    });

    afterEach(async () => {
        await fq.close();

        monitor.disconnect();
        redisClient.disconnect();

        await redisServer.stop();
    });

    beforeAll(async () => {
    });

    afterAll(async () => {
        // wtf.dump();
    });

    it("should add a url to the queue", async () => {
        await expect(fq.push(...generateAddRequest("https://example.com"))).resolves.toEqual(1);
        await expect(fq.push(...generateAddRequest("https://example1.com"))).resolves.toEqual(1);
        // duplicate shouldn't be added
        await expect(fq.push(...generateAddRequest("https://example.com"))).resolves.toEqual(0);
        await expect(fq.push(...generateAddRequest("https://example.com/index.html"))).resolves.toEqual(1);
    });

    it("should return the next url", async () => {
        const payload1 = generateAddRequest("https://example.com");
        const payload2 = generateAddRequest("https://example1.com");
        await fq.push(...payload1);
        await fq.push(...payload1);
        await fq.push(...payload2);
        await expect(fq.next()).resolves.toEqual({ hostname: "example.com", payload: payload1[1], payloadString: JSON.stringify(payload1[1]) });
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payload2[1], payloadString: JSON.stringify(payload2[1]) });
    });

    it("should return in proper order push", async () => {
        const payloads = [
            generateAddRequest("https://example.com/"),
            generateAddRequest("https://example1.com/"),
            generateAddRequest("https://example1.com/1"),
            generateAddRequest("https://example1.com/2"),
            generateAddRequest("https://example1.com/3"),
            generateAddRequest("https://example.com/1"),
        ];
        for (const payload of payloads) {
            await fq.push(...payload);
        }
        await expect(fq.next()).resolves.toEqual({ hostname: "example.com", payload: payloads[0][1], payloadString: JSON.stringify(payloads[0][1]) });
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payloads[1][1], payloadString: JSON.stringify(payloads[1][1]) });
        await fq.release("example.com", JSON.stringify(payloads[0][1]));
        await fq.release("example1.com", JSON.stringify(payloads[1][1]));
        await expect(fq.next()).resolves.toEqual({ hostname: "example.com", payload: payloads[5][1], payloadString: JSON.stringify(payloads[5][1]) });
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payloads[2][1], payloadString: JSON.stringify(payloads[2][1]) });
        await fq.release("example1.com", JSON.stringify(payloads[5][1])); // order of release matters
        await fq.release("example.com", JSON.stringify(payloads[2][1])); // order of release matters

        const extraPayload = generateAddRequest("https://example.com/2");
        await fq.push(...extraPayload);

        // we released example1.com first, so it should be picked up first
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payloads[3][1], payloadString: JSON.stringify(payloads[3][1]) });
        await expect(fq.next()).resolves.toEqual({ hostname: "example.com", payload: extraPayload[1], payloadString: JSON.stringify(extraPayload[1]) });
        await fq.release("example.com", JSON.stringify(extraPayload[1])); // order of release matters
        await fq.release("example1.com", JSON.stringify(payloads[3][1])); // order of release matters
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payloads[4][1], payloadString: JSON.stringify(payloads[4][1]) });
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

        for (const payload of payloads) {
            await fq.unshift(...payload);
        }

        await expect(fq.next()).resolves.toEqual(expect.objectContaining({ hostname: "example1.com", payload: payloads[4][1] }));
        fq.release("example1.com", JSON.stringify(payloads[4][1]));
        await expect(fq.next()).resolves.toEqual(expect.objectContaining({ hostname: "example.com", payload: payloads[5][1] }));
        fq.release("example.com", JSON.stringify(payloads[5][1]));
        await expect(fq.next()).resolves.toEqual(expect.objectContaining({ hostname: "example1.com", payload: payloads[3][1] }));
        fq.release("example1.com", JSON.stringify(payloads[3][1]));
        await expect(fq.next()).resolves.toEqual(expect.objectContaining({ hostname: "example.com", payload: payloads[0][1] }));
        fq.release("example.com", JSON.stringify(payloads[0][1]));
        await expect(fq.next()).resolves.toEqual(expect.objectContaining({ hostname: "example1.com", payload: payloads[2][1] }));
        fq.release("example1.com", JSON.stringify(payloads[2][1]));
        await expect(fq.next()).resolves.toEqual(expect.objectContaining({ hostname: "example1.com", payload: payloads[1][1] }));
        fq.release("example1.com", JSON.stringify(payloads[1][1]));
    });

    it("should lock if the queue is empty", async () => {
        const payload1 = generateAddRequest("https://example.com");
        const payload2 = generateAddRequest("https://example1.com");
        const payload3 = generateAddRequest("https://example2.com");
        await fq.push(...payload1);
        await fq.push(...payload2);
        await expect(fq.next()).resolves.toEqual({ hostname: "example.com", payload: payload1[1], payloadString: JSON.stringify(payload1[1]) });
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payload2[1], payloadString: JSON.stringify(payload2[1]) });
        const promise = fq.next();
        setTimeout(async () => {
            await fq.push(...payload3);
        }, 1000);
        await expect(promise).resolves.toEqual({ hostname: "example2.com", payload: payload3[1], payloadString: JSON.stringify(payload3[1]) });
    });

    it("should remove a url from the queue", async () => {
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

        // removes everything for the hostname
        await fq.remove("https://example.com/1");
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payloads[1][1], payloadString: JSON.stringify(payloads[1][1]) });
        await fq.release("example1.com", JSON.stringify(payloads[1][1]));
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payloads[2][1], payloadString: JSON.stringify(payloads[2][1]) });
        await fq.release("example1.com", JSON.stringify(payloads[2][1]));
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payloads[3][1], payloadString: JSON.stringify(payloads[3][1]) });
        await fq.release("example1.com", JSON.stringify(payloads[3][1]));
        await expect(fq.next()).resolves.toEqual({ hostname: "example1.com", payload: payloads[4][1], payloadString: JSON.stringify(payloads[4][1]) });
        await fq.release("example1.com", JSON.stringify(payloads[4][1]));
        setTimeout(async () => {
            await fq.push(...payloads[6]);
        }, 1000);
        await expect(fq.next()).resolves.toEqual({ hostname: "example.com", payload: payloads[6][1], payloadString: JSON.stringify(payloads[6][1]) });
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
                return;
            });
        } catch (err) {
            console.log(err);
        }
        const payloads = [
            generateAddRequest("https://example.com/"), // 0
            generateAddRequest("https://example1.com/"), // 1
            generateAddRequest("https://example1.com/1"), // 2
            generateAddRequest("https://example1.com/2"), // 3
            generateAddRequest("https://example1.com/3"), // 4
            generateAddRequest("https://example.com/1"), // 5
            generateAddRequest("https://example.com/2"), // 6
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

        expect(results[0]).toEqual(payloads[0][1]);
        expect(results[1]).toEqual(payloads[1][1]);
        expect(results[2]).toEqual(payloads[5][1]);
        expect(results[3]).toEqual(payloads[2][1]);
        expect(results[4]).toEqual(payloads[6][1]);
        expect(results[5]).toEqual(payloads[3][1]);
        expect(results[6]).toEqual(payloads[4][1]);
    }, 10000);

    it("host limits", async () => {
        const now = Date.now();
        const times: number[] = [];
        const results: FairQueuePayload[] = [];
        try {
            let counter = 0;
            fq.process(12, async (payload: FairQueuePayload) => {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                if (counter++ === 0) {
                    throw new Error("failed");
                }
                times.push(new Date().getTime());
                results.push(payload);
                return;
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
        await Promise.all(payloads.map((payload) => fq.push(...payload)));
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

        expect(results[0]).toEqual(payloads[1][1]); // now + 2000
        expect(results[1]).toEqual(payloads[2][1]); // now + 3000
        expect(results[2]).toEqual(payloads[3][1]); // now + 4000
        expect(results[3]).toEqual(payloads[4][1]); // now + 5000
        expect(results[4]).toEqual(payloads[5][1]); // now + 6000
    }, 10000);

    it("host limits recovery", async () => {
        let now = Date.now();
        const times: number[] = [];
        const results: FairQueuePayload[] = [];
        fq.process(100, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            times.push(new Date().getTime());
            results.push(payload);
            return;
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

        const fq2 = new FairQueue<FairQueuePayload>("test", { redis: { host, port }, staleInterval: 1000 }).on("error", (err) => {
            console.log("caught error", err);
        });

        now = Date.now();
        fq2.process(100, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            times.push(new Date().getTime());
            results.push(payload);
            return;
        });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(times.length).toEqual(6);
        expect(times[4]).toBeGreaterThanOrEqual(now + 1000);
        expect(times[4]).toBeLessThanOrEqual(now + 1200);
        expect(times[5]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[5]).toBeLessThanOrEqual(now + 2200);

        expect(results[0]).toEqual(payloads[0][1]); // now + 1000
        expect(results[1]).toEqual(payloads[1][1]); // now + 2000
        expect(results[2]).toEqual(payloads[2][1]); // now + 3000
        expect(results[3]).toEqual(payloads[3][1]); // now + 4000
        expect(results.slice(4).sort()).toEqual([
            payloads[4][1],
            payloads[5][1]
        ].sort()); // now + 1000

        await fq2.close();
    }, 20000);

    it("host limits with delay", async () => {
        const now = Date.now();
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
                return;
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

        expect(results[0]).toEqual(payloads[1][1]); // now + 2000
        expect(results[1]).toEqual(payloads[2][1]); // now + 3000
        expect(results[2]).toEqual(payloads[3][1]); // now + 4000
        expect(results[3]).toEqual(payloads[4][1]); // now + 5000
        expect(results[4]).toEqual(payloads[5][1]); // now + 6000
    }, 10000);

    it("host limits parallel (multiple queue)", async () => {
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
        for (let i = 0; i < payloads.length * 2; i++) {
            const fq = new FairQueue("test", { redis: { host, port } }).on("error", (err) => {
                console.log("caught error", err);
            });
            fqs.push(fq);
        }

        fqs.forEach((fq) => {
            fq.process(100, async (payload: FairQueuePayload) => {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                times.push(new Date().getTime());
                results.push(payload);
                return;
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
        expect(times[0]).toBeLessThanOrEqual(now + 1200);
        expect(times[1]).toBeGreaterThanOrEqual(now + 2000);
        expect(times[1]).toBeLessThanOrEqual(now + 2200);
        expect(times[2]).toBeGreaterThanOrEqual(now + 3000);
        expect(times[2]).toBeLessThanOrEqual(now + 3200);
        expect(times[3]).toBeGreaterThanOrEqual(now + 4000);
        expect(times[3]).toBeLessThanOrEqual(now + 4200);
        expect(times[4]).toBeGreaterThanOrEqual(now + 5000);
        expect(times[4]).toBeLessThanOrEqual(now + 5200);
        expect(times[5]).toBeGreaterThanOrEqual(now + 6000);
        expect(times[5]).toBeLessThanOrEqual(now + 6200);

        expect(results[0]).toEqual(payloads[0][1]); // now + 1000
        expect(results[1]).toEqual(payloads[1][1]); // now + 2000
        expect(results[2]).toEqual(payloads[2][1]); // now + 3000
        expect(results[3]).toEqual(payloads[3][1]); // now + 4000
        expect(results[4]).toEqual(payloads[4][1]); // now + 5000
        expect(results[5]).toEqual(payloads[5][1]); // now + 6000

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
            return;
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
        expect(results[0]).toEqual(payloads[0][1]); // 'https://example.com/' 
        expect(results[1]).toEqual(payloads[1][1]); // 'https://example.com/1' parallel with previous 
        expect(results[2]).toEqual(payloads[5][1]); // 'https://example1.com/' 
        expect(results[3]).toEqual(payloads[2][1]); // 'https://example.com/2' parallel with previous
        expect(results[4]).toEqual(payloads[3][1]); // 'https://example.com/3'
        expect(results[5]).toEqual(payloads[6][1]); // 'https://example1.com/1' parallel with previous
        expect(results[6]).toEqual(payloads[4][1]); // 'https://example.com/4' 
        expect(results[7]).toEqual(payloads[7][1]); // 'https://example1.com/2' parallel with previous
    }, 10000);


    it("per host concurrency decrease", async () => {
        const now = Date.now();
        const times: number[] = [];
        const results: FairQueuePayload[] = [];
        fq.process(2, async (payload: FairQueuePayload) => {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // should never finish
            times.push(new Date().getTime());
            results.push(payload);
            return;
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
        expect(results[0]).toEqual(payloads[0][1]); // 'https://example.com/' 
        expect(results[1]).toEqual(payloads[1][1]); // 'https://example.com/1' parallel with previous 
        expect(results[2]).toEqual(payloads[2][1]); // 'https://example1.com/' 
        expect(results[3]).toEqual(payloads[3][1]); // 'https://example.com/2' parallel with previous
        expect(results[4]).toEqual(resetConcurrencyPayloads[2][1]); // 'https://example1.com/1'
        expect(results[5]).toEqual(resetConcurrencyPayloads[0][1]); // 'https://example.com/3'  parallel with previous
        expect(results[6]).toEqual(resetConcurrencyPayloads[3][1]); // 'https://example1.com/2' parallel with previous
        expect(results[7]).toEqual(resetConcurrencyPayloads[1][1]); // 'https://example.com/4' 
    }, 10000);

    it("stats", async () => {
        const payloads = [
            generateAddRequest("https://example.com/", 4),
            generateAddRequest("https://example1.com/", 4),
            generateAddRequest("https://example1.com/1", 4),
            generateAddRequest("https://example1.com/2", 4),
            generateAddRequest("https://example1.com/3", 4),
            generateAddRequest("https://example.com/1", 4),
            generateAddRequest("https://example.com/2", 4),
        ];
        for (const payload of payloads) {
            await fq.push(...payload);
        }

        // this is for concurrency 1
        // await expect(fq.stats()).resolves.toEqual({ pending: 0, total: 2 });
        // await expect(fq.stats('example.com')).resolves.toEqual({ pending: 0, total: 1, urls: 3 });
        // await expect(fq.stats('example1.com')).resolves.toEqual({ pending: 0, total: 1, urls: 4 });

        // this is for concurrency 4 for each host
        await expect(fq.stats()).resolves.toEqual({ pending: 0, total: 7, urls: 7 });
        await expect(fq.stats("example.com")).resolves.toEqual({ pending: 0, total: 3, urls: 3 });
        await expect(fq.stats("example1.com")).resolves.toEqual({ pending: 0, total: 4, urls: 4 });
        await expect(fq.queuedHosts()).resolves.toEqual([
            "example.com",
            "example1.com",
            "example1.com",
            "example1.com",
            "example1.com",
            "example.com",
            "example.com",
        ]);
        await expect(fq.queuedHosts(true)).resolves.toEqual({
            "example.com": 3,
            "example1.com": 4,
        });
        await expect(fq.pendingHosts()).resolves.toEqual([]);

        fq.process(8, async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // should never finish
            return;
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        await expect(fq.stats()).resolves.toEqual({ pending: 7, total: 7, urls: 7 });
        await expect(fq.stats("example.com")).resolves.toEqual({ pending: 3, total: 3, urls: 0 });
        await expect(fq.stats("example1.com")).resolves.toEqual({ pending: 4, total: 4, urls: 0 });
        await expect(fq.queuedHosts()).resolves.toEqual([]);
        await expect(fq.pendingHosts()).resolves.toEqual([
            "example.com",
            "example1.com",
            "example1.com",
            "example1.com",
            "example1.com",
            "example.com",
            "example.com",
        ]);
        await expect(fq.pendingHosts(true)).resolves.toEqual({
            "example.com": 3,
            "example1.com": 4,
        });
    });


    it("position in queue 1", async () => {
        const payloads = [
            generateAddRequest("https://example.com/", 1),
            generateAddRequest("https://example1.com/", 1),
            generateAddRequest("https://example1.com/1", 1),
            generateAddRequest("https://example1.com/2", 1),
            generateAddRequest("https://example1.com/3", 1),
            generateAddRequest("https://example.com/1", 1),
            generateAddRequest("https://example.com/2", 1),
        ];
        for (const payload of payloads) {
            await fq.push(...payload);
        }

        await expect(fq.urlPositionInQueue("https://example.com/")).resolves.toEqual(0);
        await expect(fq.urlPositionInQueue("https://example1.com/")).resolves.toEqual(1);
        await expect(fq.urlPositionInQueue("https://example.com/1")).resolves.toEqual(2);
        await expect(fq.urlPositionInQueue("https://example1.com/1")).resolves.toEqual(3);
        await expect(fq.urlPositionInQueue("https://example.com/2")).resolves.toEqual(4);
        await expect(fq.urlPositionInQueue("https://example1.com/2")).resolves.toEqual(5);
        await expect(fq.urlPositionInQueue("https://example1.com/3")).resolves.toEqual(6);
        await expect(fq.urlPositionInQueue("https://example1.com/4")).resolves.toEqual(-1);
        await expect(fq.urlPositionInQueue("https://example.com/4")).resolves.toEqual(-1);
        await expect(fq.urlPositionInQueue("https://example2.com/")).resolves.toEqual(-1);
    });

    it("position in queue 2", async () => {
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

        await expect(fq.urlPositionInQueue("https://example.com/")).resolves.toEqual(0);
        await expect(fq.urlPositionInQueue("https://example1.com/")).resolves.toEqual(1);
        await expect(fq.urlPositionInQueue("https://example.com/1")).resolves.toEqual(2);
        await expect(fq.urlPositionInQueue("https://example.com/2")).resolves.toEqual(3);
        await expect(fq.urlPositionInQueue("https://example1.com/1")).resolves.toEqual(4);
        await expect(fq.urlPositionInQueue("https://example1.com/2")).resolves.toEqual(5);
        await expect(fq.urlPositionInQueue("https://example1.com/3")).resolves.toEqual(6);
        await expect(fq.urlPositionInQueue("https://example1.com/4")).resolves.toEqual(-1);
        await expect(fq.urlPositionInQueue("https://example.com/4")).resolves.toEqual(-1);
        await expect(fq.urlPositionInQueue("https://example2.com/")).resolves.toEqual(-1);
    });

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
        await expect(fq.urlPositionInQueue("https://example.com/")).resolves.toEqual(-1);
        await expect(fq.urlPositionInQueue("https://example1.com/")).resolves.toEqual(0);
        await expect(fq.urlPositionInQueue("https://example.com/1")).resolves.toEqual(-1);
        await expect(fq.urlPositionInQueue("https://example.com/2")).resolves.toEqual(-1);
        await expect(fq.urlPositionInQueue("https://example1.com/1")).resolves.toEqual(1);
        await expect(fq.urlPositionInQueue("https://example1.com/2")).resolves.toEqual(2);
        await expect(fq.urlPositionInQueue("https://example1.com/3")).resolves.toEqual(3);
        await expect(fq.urlPositionInQueue("https://example1.com/4")).resolves.toEqual(-1);
        await expect(fq.urlPositionInQueue("https://example.com/4")).resolves.toEqual(-1);
        await expect(fq.urlPositionInQueue("https://example2.com/")).resolves.toEqual(-1);
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
        let count = payloads.length;
        let recovered = false;
        const urls: string[] = [];
        fq.process(100, async (payload: FairQueuePayload) => {
            count--;
            urls.push(payload.url);
            let interval: NodeJS.Timeout;
            return new Promise((resolve) => interval = setInterval(() => {
                if (recovered) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100));
        });
        
        await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (count === 0) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });

        const fq2 = new FairQueue("test", { redis: { host, port }, staleInterval: 1000 }).on("error", (err) => {
            console.error("caught error", err);
        });
        await fq2.wakeUp();
        await fq2.close();

        // recovered urls should also start getting into the queue
        recovered = true;
        await new Promise((resolve) => setTimeout(resolve, 0));

        // now we want stop processing
        await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (count === -1 * payloads.length) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });

        // the order of insertion is predictable,
        // but order of processing is not, so we sort the urls
        expect(urls.slice(payloads.length).sort()).toEqual([
            "https://example.com/",
            "https://example1.com/1",
            "https://example1.com/3",
            "https://example.com/2",
            "https://example.com/1",
            "https://example1.com/2",
            "https://example1.com/"
        ].sort());
    });

    it("should distribute jobs across multiple queues in a loop", async () => {
        const numQueues = 3;
        const numIterations = 10;

        for (let iteration = 0; iteration < numIterations; iteration++) {
            const queues = [];
            const jobsPerQueue = new Array(numQueues + 1).fill(0);
            const queueName = `test-${iteration}`;
            
            const fq = new FairQueue(queueName, { redis: { host, port } }).on("error", (err) => {
                console.log("caught error", err);
            });

            // Create multiple FairQueue instances
            for (let i = 0; i < numQueues; i++) {
                const fqInstance = new FairQueue(queueName, { redis: { host, port } }).on("error", (err) => {
                    console.log("caught error", err);
                });
                queues.push(fqInstance);
            }
    
            // Set up processing on each queue
            queues.forEach((fqInstance, index) => {
                fqInstance.process(10, async () => {
                    // console.log("processing", index);
                    jobsPerQueue[index]++;
                    // Simulate some processing time
                    await new Promise((resolve) => setTimeout(resolve, 100)); // + Math.floor(Math.random() * 100)));
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
            await Promise.all(payloads.map((payload) => fq.push(...payload)));
            const fqInstance = new FairQueue(queueName, { redis: { host, port } }).on("error", (err) => {
                console.log("caught error", err);
            });
            queues.push(fqInstance);

            fqInstance.process(10, async () => {
                jobsPerQueue[numQueues]++;
                // Simulate some processing time
                await new Promise((resolve) => setTimeout(resolve, 100));
            });

            // Wait for processing to complete
            await new Promise((resolve) => setTimeout(resolve, 5000));
    
            // Check that each queue processed at least one job
            const queuesWithJobs = jobsPerQueue.filter((count) => count > 0).length;
            // console.log(`Iteration ${iteration}, Queues with jobs: ${queuesWithJobs}, Jobs per queue: ${jobsPerQueue}`);
            expect(queuesWithJobs).toBe(numQueues + 1);
            // during wake up, some of the jobs will be requeued
            expect(jobsPerQueue.reduce((acc, count) => acc + count, 0)).toBeGreaterThanOrEqual(numJobs);
    
            // Close all queues
            await Promise.all(queues.map((fqInstance) => fqInstance.close()));
            await fq.close();
        }
    }, 60000);

    it("should distribute jobs evenly when number of hosts < number of processors", async () => {
        const numQueues = 6; // processors
        const hosts = ["example1.com", "example2.com", "example3.com"];
        const numHosts = hosts.length;  // hosts
        const urlsPerHost = 100;
        const queueName = "test-distribution";
        
        const queues = [];
        const jobsPerQueue = new Array(numQueues).fill(0);
        
        // Main queue for adding jobs
        const fq = new FairQueue(queueName, { redis: { host, port } })
            .on("error", (err) => console.log("caught error", err));
    
        // Add 100 URLs for each host
        const payloads: Array<GeneratedPayload> = [];
        
        hosts.forEach(hostname => {
            for (let i = 0; i < urlsPerHost; i++) {
                const url = `https://${hostname}/page${i}`;
                payloads.push(generateAddRequest(url));
            }
        });

        // Add all jobs
        await Promise.all(payloads.map((payload) => fq.push(...payload)));

        // Create multiple processor instances
        // after the queue has 
        for (let i = 0; i < numQueues; i++) {
            const fqInstance = new FairQueue(queueName, { redis: { host, port } })
                .on("error", (err) => console.log("caught error", err));
            fqInstance.process(10, async () => {
                jobsPerQueue[i]++;
                // Fixed processing time to eliminate timing variance
                await new Promise((resolve) => setTimeout(resolve, 200)); // + Math.floor(Math.random() * 300)));
            });
            queues.push(fqInstance);
        }
    
        // Wait for processing to complete (100ms per job + buffer)
        await new Promise((resolve) => setTimeout(resolve, 30000));
    
        // Close all queues
        await Promise.all([...queues, fq].map(q => q.close()));
    
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

        const fq2 = new FairQueue("test", { redis: { host, port } }).on("error", (err) => {
            console.log("caught error", err);
        });
        const fq3 = new FairQueue("test", { redis: { host, port } }).on("error", (err) => {
            console.log("caught error", err);
        });
        const fq4 = new FairQueue("test", { redis: { host, port } }).on("error", (err) => {
            console.log("caught error", err);
        });

        fq.process(1, async (...args) => {
            debug("args 1", args);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            debug("fq process done", args);
        });

        fq2.process(1, async (...args) => {
            debug("args 2", args);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            debug("fq2 process done", args);
        });

        await new Promise((resolve) => setTimeout(resolve, 200));

        await fq.push(...generateAddRequest("https://dead-example1.com/"));
        await fq.push(...generateAddRequest("https://dead-example2.com/")); 
        await fq.push(...generateAddRequest("https://dead-example3.com/"));
        await fq.push(...generateAddRequest("https://dead-example4.com/"));
        // const pending = [];
        // for (let i = 0; i < 3; i++) {
        //     const { hostname, payloadString } = await fq.next(); // host in pending
        //     pending.push({ hostname, payloadString });
        // }

        await new Promise((resolve) => setTimeout(resolve, 200));
        debug("fq stats", await fq.stats());
        await expect(fq.stats()).resolves.toEqual({ pending: 2, total: 4, urls: 4 });

        fq3.process(1, async (...args) => {
            debug("args 3", args);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            debug("fq3 process done", args);
        });

        fq4.process(1, async (...args) => {
            debug("args 4", args);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            debug("fq4 process done", args);
        });

        await new Promise((resolve) => setTimeout(resolve, 200));
        debug("fq stats", await fq.stats());
        await expect(fq.stats()).resolves.toEqual({ pending: 2, total: 4, urls: 4 });
        // await fq2.wakeUp();
        // await fq3.wakeUp();

        // await expect(fq.stats()).resolves.toEqual({ pending: 0, total: 3, urls: 3 });

        // const pending2 = [];
        // for (let i = 0; i < 3; i++) {
        //     const { hostname, payloadString } = await fq2.next(); // host in pending
        //     pending2.push({ hostname, payloadString });
        // }
        // const stats2 = await fq.stats();
        // console.log("stats2", stats2);

        // // for (const { hostname, payloadString } of pending) {
        // //     await fq.release(hostname, payloadString);
        // // }

        // const stats3 = await fq.stats();
        // console.log("stats3", stats3);
        // expect(stats.pending).toBe(3); // 3 pending hosts
        await fq2.close();
        await fq3.close();
        await fq4.close();
    });

    it("duplicated host after parallel wakeUps on the same machineId", async () => {
        // 1. Arrange – host is in pending-hosts + pending-payloads
        const payload = generateAddRequest("https://dup-example.com/");
        await fq.push(...payload);
        const { hostname } = await fq.next(); // host in pending
        // await fq.blockingRedis.disconnect(); // stop the worker, no release()

        // 2. Spin up four processes that share hostname ⇒ same machineId
        const procs: FairQueue<FairQueuePayload>[] = [];
        for (let i = 0; i < 4; i++) {
            procs.push(new FairQueue<FairQueuePayload>("test", { redis: { host, port } }));
        }
        await Promise.all(procs.map((p) => p.wakeUp()));

        // 3. There must be **≤1** copy of the host across main+pending
        const [main, pending] = await Promise.all([
            redisClient.lrange(`${FAIR_QUEUE_NAME}:test`, 0, -1),
            redisClient.lrange(`${FAIR_QUEUE_NAME}:test:pending-hosts`, 0, -1),
        ]);
        const total = [...main, ...pending].filter((h) => h === hostname).length;
        expect(total).toBe(1); // fails → got 2

        await Promise.all(procs.map((p) => p.close()));
    });

    it("no duplicate pending hosts when two releases race", async () => {
        // concurrency = 1, but we queue three payloads so two workers can race
        const hostUrl = "https://race-example.com/";
        await fq.push(...generateAddRequest(hostUrl + "1", 2));
        await fq.push(...generateAddRequest(hostUrl + "2", 2));
        await fq.push(...generateAddRequest(hostUrl + "3", 2));

        // Two independent workers on the same host (same machineId)
        const worker1 = new FairQueue("test", { redis: { host, port } });
        const worker2 = new FairQueue("test", { redis: { host, port } });

        const barrier: (() => void)[] = [];
        const wait = () => new Promise<void>((resolve) => barrier.push(resolve));

        for (const w of [worker1, worker2]) {
            w.process(1, async () => {
                await wait(); // both workers finish together
            });
        }

        // Let both next()/processing finish and hit the barrier…
        await new Promise((res) => setTimeout(res, 200));

        let queuedHosts, pendingHosts;
        queuedHosts = (await worker1.queuedHosts(true)) as Record<string, number>;
        pendingHosts = (await worker1.pendingHosts(true)) as Record<string, number>;
        barrier.forEach((resolve) => resolve());
        // …then allow release() to run
        await new Promise((res) => setTimeout(res, 200));
        queuedHosts = (await worker1.queuedHosts(true)) as Record<string, number>;
        pendingHosts = (await worker1.pendingHosts(true)) as Record<string, number>;

        expect(queuedHosts["race-example.com"]).toBeUndefined();
        expect(pendingHosts["race-example.com"]).toBe(1);
        barrier.forEach((resolve) => resolve());

        await Promise.all([worker1.close(), worker2.close()]);
    });

});