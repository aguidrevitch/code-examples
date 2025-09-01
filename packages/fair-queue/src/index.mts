import { RedisOptions, Redis } from "ioredis";
import { LUA_UNSHIFT, LUA_PUSH, LUA_NEXT, LUA_REMOVE, LUA_RELEASE, LUA_CONCURRENCY } from "./lib/lua.mjs";
import { FAIR_QUEUE_NAME } from "./lib/constants.mjs";
import { EventEmitter } from "events";
import { performance } from "perf_hooks";
import os from "os";

// to fix the issue with the pending-hosts queue
// EVAL "local src = KEYS[1]\nlocal dst = KEYS[2]\nlocal count = redis.call('LLEN', src)\nfor i = 1, count do\nlocal val = redis.call('LPOP', src)\nredis.call('RPUSH', dst, val)\nend" 2 fpo-fair-queue:optimize-v2:pending-hosts fpo-fair-queue:optimize-v2

// Define scripts configuration for ioredis
const REDIS_SCRIPTS = {
    fairQueueUnshift: {
        lua: LUA_UNSHIFT,
        numberOfKeys: 4,
    },
    fairQueuePush: {
        lua: LUA_PUSH,
        numberOfKeys: 4,
    },
    fairQueueNext: {
        lua: LUA_NEXT,
        numberOfKeys: 3,
    },
    fairQueueRemove: {
        lua: LUA_REMOVE,
        numberOfKeys: 2,
    },
    fairQueueRelease: {
        lua: LUA_RELEASE,
        numberOfKeys: 4,
    },
    fairQueueConcurrency: {
        lua: LUA_CONCURRENCY,
        numberOfKeys: 2,
    },
};

/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars */
export interface FairQueuePayload {
    url: string;
    [key: string]: unknown;
}

export interface FairQueueProcessCallback<T extends FairQueuePayload> {
    (payload: T): Promise<void>;
}

// Add declarations
declare module "ioredis" {
    interface RedisCommander<Context> {
        fairQueueUnshift(name: string, hostname: string, payload: string, concurrency: number): Promise<number>;
        fairQueuePush(name: string, hostname: string, payload: string, concurrency: number): Promise<number>;
        fairQueueNext(name: string, machineId: string, hostname: string): Promise<string>;
        fairQueueRelease(name: string, machineId: string, hostname: string, payloadString: string): Promise<unknown>;
        fairQueueRemove(name: string, hostname: string): Promise<number>;
        fairQueueConcurrency(name: string, hostname: string): Promise<number>;
    }
}
/* eslint-enable @typescript-eslint/no-unused-vars, no-unused-vars */

export class FairQueue<T extends FairQueuePayload> extends EventEmitter {
    public machineId: string;
    public name: string;
    public maxQueueLength?: number;
    public active: boolean = true;
    public wokenUp: boolean = false;
    private staleInterval: number = 60 * 1000;
    private redis: Redis;
    private blockingRedis: Redis;
    private activePromises = new Set<Promise<void>>();

    constructor(
        name: string,
        { redis, staleInterval }: { redis: RedisOptions; staleInterval?: number },
        hostname?: string,
        maxQueueLength?: number
    ) {
        super();
        this.name = name;
        this.redis = new Redis({
            ...redis,
            scripts: REDIS_SCRIPTS,
        });
        this.blockingRedis = new Redis({
            ...redis,
            scripts: REDIS_SCRIPTS,
        });
        // this.redis.on("error", (err) => {
        //     this.emit("error", err);
        // });
        // this.blockingRedis.on("error", (err) => {
        //     this.emit("error", err);
        // });
        if (staleInterval) {
            this.staleInterval = staleInterval;
        }
        if (!hostname) {
            hostname = os.hostname();
        }
        let hash = 0;
        for (let i = 0; i < hostname.length; i++) {
            const char = hostname.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash |= 0; // Convert to 32-bit integer
        }
        this.machineId = hash.toString(16); // Convert to a hexadecimal string
        this.maxQueueLength = maxQueueLength;
    }
    get mainQueue() {
        return `${FAIR_QUEUE_NAME}:${this.name}`;
    }
    get pendingHostsQueue() {
        return `${this.mainQueue}:pending-hosts`;
    }
    get pendingPayloadsQueue() {
        return `${this.mainQueue}:${this.machineId}:pending-payloads`;
    }
    hostQueue(hostname: string) {
        return `${this.mainQueue}:${hostname}`;
    }
    async concurrency(hostname: string): Promise<number> {
        return this.redis.fairQueueConcurrency(this.name, hostname);
    }
    // we lose concurrency information on wake up
    // good enough for a start
    async wakeUp() {
        if (this.wokenUp) {
            throw new Error("Queue is already woken up");
        }
        // we need to reprocess the pending-payloads queue on restart
        // so we can recover the state
        const pendingPayloadStrings = (await this.redis.lrange(this.pendingPayloadsQueue, 0, -1)) as string[];
        const payloads = [];
        for (const pendingPayloadString of pendingPayloadStrings) {
            const payload = JSON.parse(pendingPayloadString);
            const hostname = new URL(payload.url).hostname;
            const concurrency: number = (await this.concurrency(hostname)) || 1;
            payloads.push([hostname, payload, concurrency, pendingPayloadString]);
        }
        // clean pendingHostsQueue
        // why ?????????
        // we actually wanted to move hosts from the pending queue to the main queue
        // we are going to do this with LUA_RELEASE, as it doesn't check whether the payload
        // exists in the pending-payloads queue
        for (const [hostname, payload, concurrency, pendingPayloadString] of payloads) {
            await this.release(hostname, pendingPayloadString);
            await this.unshift(payload.url, payload, concurrency);
        }
        this.emit("wakeup", { payloads });
        this.wokenUp = true;
    }
    // for backward compatibility
    async add(url: string, payload: T, concurrency?: number): Promise<number> {
        return this.push(url, payload, concurrency);
    }
    async push(url: string, payload: T, concurrency?: number): Promise<number> {
        const hostname = new URL(url).hostname;
        if (concurrency === 0) {
            throw new Error("Concurrency should be a positive number");
        }
        if (!concurrency) {
            concurrency = 1;
        }
        if (concurrency < 1) {
            throw new Error("Concurrency should be a positive number");
        }
        if (concurrency > 20) {
            // seems like a reasonable limit of pages processed per host
            throw new Error("Concurrency should be less than 20");
        }
        const hostQueue = this.hostQueue(hostname);
        const hostQueueLength = await this.redis.llen(hostQueue);
        if (this.maxQueueLength && hostQueueLength >= this.maxQueueLength) {
            // we don't want to push the payload if the queue is full
            return 0;
        }
        return this.redis.fairQueuePush(this.name, hostname, JSON.stringify(payload), concurrency);
    }
    async unshift(url: string, payload: T, concurrency?: number): Promise<number> {
        const hostname = new URL(url).hostname;
        if (concurrency === 0) {
            throw new Error("Concurrency should be a positive number");
        }
        if (!concurrency) {
            concurrency = 1;
        }
        if (concurrency < 1) {
            throw new Error("Concurrency should be a positive number");
        }
        if (concurrency > 20) {
            // seems like a reasonable limit of pages processed per host
            throw new Error("Concurrency should be less than 20");
        }
        return this.redis.fairQueueUnshift(this.name, hostname, JSON.stringify(payload), concurrency);
    }
    async remove(url: string): Promise<number> {
        const hostname = new URL(url).hostname;
        return this.redis.fairQueueRemove(this.name, hostname);
    }
    async next(): Promise<{ hostname: string; payloadString: string; payload: T }> {
        while (this.active) {
            // need to duplicate the connection because blpop is blocking the whole connection
            // const result = await this.blockingRedis.blpop(this.mainQueue, 0);
            const hostname = await this.blockingRedis.blmove(
                this.mainQueue,
                this.pendingHostsQueue,
                "LEFT",
                "RIGHT",
                0
            );

            if (hostname) {
                // const [, hostname] = result as [string, string];
                const payloadString = await this.redis.fairQueueNext(this.name, this.machineId, hostname);
                if (payloadString) {
                    return {
                        hostname,
                        payloadString,
                        payload: JSON.parse(payloadString) as T,
                    };
                }
            } else {
                // this will never happen, hostname is null
            }
        }
        throw new Error("Queue is not active");
    }
    async release(hostname: string, payloadString: string): Promise<unknown> {
        return this.redis.fairQueueRelease(this.name, this.machineId, hostname, payloadString);
    }
    async purge(url: string): Promise<number> {
        try {
            const hostname = new URL(url).hostname;
            // we only want to catch the error in URL parsing
            // if any. If the redis fail - let external code
            // handle it, so no await here.
            // we want this.redis.del to throw an error in fact
            return this.redis.del(this.hostQueue(hostname));
        } catch (err) {
            this.emit("error", err);
            return 0;
        }
    }
    async process(concurrency: number, callback: FairQueueProcessCallback<T>): Promise<void> {
        // we need to reprocess the pending-hosts queue on restart
        // so we can recover the state
        await this.wakeUp();

        while (this.active) {
            if (this.activePromises.size < concurrency) {
                try {
                    const { hostname, payloadString, payload } = await this.next();

                    if (!this.active) {
                        // will be recovered on subsequent wake up
                        break;
                    }

                    const performanceId = Math.random().toString(36).substring(2);
                    performance.mark("fair-queue:start:" + performanceId);
                    const promise = callback(payload)
                        .catch((err) => {
                            this.emit("error", err);
                        })
                        .finally(async () => {
                            try {
                                await this.release(hostname, payloadString);
                            } catch (err) {
                                // what should we do if we failed to release the host?
                                // we also get here if connection was closed
                                if (this.active) {
                                    this.emit("error", err);
                                }
                            }
                            performance.mark("fair-queue:end:" + performanceId);
                            performance.measure("fair-queue", {
                                detail: payload,
                                start: "fair-queue:start:" + performanceId,
                                end: "fair-queue:end:" + performanceId,
                            });
                            this.activePromises.delete(promise);
                        });

                    this.activePromises.add(promise);
                } catch (err) {
                    // this.next() failed
                    // we also get here if connection was closed
                    if (this.active) {
                        this.emit("error", err);
                    }
                    break;
                }
            } else {
                // Set() is iterable, so this works without converting to an array
                await Promise.race(this.activePromises);
                this.emit("release");
            }
        }
        // Waiting for all ongoing tasks to complete before exiting.
        // await Promise.all(this.activePromises);
    }
    async close() {
        this.active = false;
        try {
            await Promise.all(this.activePromises);
            // we can't use quit here, because this.blockingRedis is blocking
            // await this.redis.quit();
            this.blockingRedis.disconnect();
            this.redis.disconnect();
        } catch (err) {
            this.emit("error", err);
        }
    }
    async stats(hostname?: string): Promise<{ pending: number; total: number; urls: number }> {
        const pendingHostsQueue = await this.redis.lrange(this.pendingHostsQueue, 0, -1);
        const mainQueue = await this.redis.lrange(this.mainQueue, 0, -1);
        if (hostname) {
            const urls = await this.redis.lrange(this.hostQueue(hostname), 0, -1);
            const pending = pendingHostsQueue.filter((pending) => pending === hostname).length;
            const main = mainQueue.filter((queue) => queue === hostname).length;
            return {
                pending,
                total: main + pending,
                urls: urls.length,
            };
        } else {
            const uniqueHosts = new Set([...pendingHostsQueue, ...mainQueue]);
            const urls = await Promise.all(
                [...uniqueHosts].map(async (hostname) => {
                    return this.redis.llen(this.hostQueue(hostname));
                })
            );
            return {
                pending: pendingHostsQueue.length,
                total: mainQueue.length + pendingHostsQueue.length,
                urls: urls.reduce((acc, count) => acc + count, 0) + pendingHostsQueue.length,
            };
        }
    }
    async queuedHosts(grouped?: boolean): Promise<{ [key: string]: number } | string[]> {
        const hosts = await this.redis.lrange(this.mainQueue, 0, -1);
        if (hosts.length > 0) {
            // count the number of times each host appears in the main queue
            if (grouped) {
                return hosts.reduce(
                    (acc, host) => {
                        acc[host] = (acc[host] || 0) + 1;
                        return acc;
                    },
                    {} as { [key: string]: number }
                );
            } else {
                return hosts;
            }
        } else {
            return grouped ? {} : [];
        }
    }
    async pendingHosts(grouped?: boolean): Promise<{ [key: string]: number } | string[]> {
        const hosts = await this.redis.lrange(this.pendingHostsQueue, 0, -1);
        if (hosts.length > 0) {
            // count the number of times each host appears in the main queue
            if (grouped) {
                return hosts.reduce(
                    (acc, host) => {
                        acc[host] = (acc[host] || 0) + 1;
                        return acc;
                    },
                    {} as { [key: string]: number }
                );
            } else {
                return hosts;
            }
        } else {
            return grouped ? {} : [];
        }
    }
    async urlPositionInQueue(url: string): Promise<number> {
        const queueLengths: { [key: string]: number } = {};
        const hostname = new URL(url).hostname;
        const hostQueue = await this.redis.lrange(this.hostQueue(hostname), 0, -1);

        queueLengths[hostname] = -1;
        for (let i = 0; i < hostQueue.length; i++) {
            const parsed = JSON.parse(hostQueue[i]);
            if (parsed.url === url) {
                queueLengths[hostname] = i;
                break;
            }
        }

        if (queueLengths[hostname] === -1) {
            return -1;
        }

        const [pendingHosts, mainQueue] = await Promise.all([
            this.redis.lrange(this.pendingHostsQueue, 0, -1),
            this.redis.lrange(this.mainQueue, 0, -1),
        ]);

        let position = 0;
        let done = false;
        // lets repeat the main logics of the queue until we find the position
        const zeroedQueueLengths: { [key: string]: boolean } = {};
        [...pendingHosts, ...mainQueue].forEach((host) => (zeroedQueueLengths[host] = false));

        while (!done) {
            for (const queuedHost of [...pendingHosts, ...mainQueue]) {
                if (typeof queueLengths[queuedHost] === "undefined") {
                    queueLengths[queuedHost] = await this.redis.llen(this.hostQueue(queuedHost));
                }
                if (queueLengths[queuedHost] === 0) {
                    zeroedQueueLengths[queuedHost] = true;
                    if (hostname === queuedHost) {
                        done = true;
                        return position;
                    } else {
                        continue;
                    }
                }
                position += 1;
                queueLengths[queuedHost] -= 1;
            }
            // Sanity check
            // if all the queues were zeroed, but we didn't find the position, something is wrong with the logic
            // if (Object.values(zeroedQueueLengths).filter(value => value === false).length === 0) {
            if (Object.values(zeroedQueueLengths).every(Boolean)) {
                throw new Error("Sanity check failed");
            }
        }
        return position;
    }
}
