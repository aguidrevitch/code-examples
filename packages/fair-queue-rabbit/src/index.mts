import amqplib, { ChannelModel, ConfirmChannel, GetMessage, Options, Replies } from "amqplib";
import { FAIR_QUEUE_NAME } from "./lib/constants.mjs";
import { EventEmitter } from "events";
import { performance } from "perf_hooks";
import { randomUUID } from "crypto";
import { FairQueueCache } from "./types/fair-queue-cache.mjs";
import { Redis, RedisOptions } from "ioredis";
import { LUA_ADD_WITH_CONCURRENCY, LUA_FIND_AND_MOVE, LUA_WAKE_UP } from "./lib/lua.mjs";
import { RedisCache } from "./lib/redis-cache.mjs";
import { serializeError } from "./lib/serialize-error.mjs";
import { FairQueuePayload } from "./types/fair-queue.mjs";
export * from "./types/fair-queue.mjs";

/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars */
export interface FairQueueProcessCallback<T extends FairQueuePayload, K> {
    (payload: T): Promise<K>;
}

export type FairQueueError = {
    name: string;
    message: string;
    stack?: string;
    cause?: FairQueueError;
};

export type FairQueueResult<T, K> =
    | {
          eventType: "success";
          payload: T;
          result: K;
      }
    | {
          eventType: "error";
          payload: T;
          error: FairQueueError;
      };

/**
 * Type guard to check if a FairQueueResult is a success result
 */
export function isSuccess<T, K>(
    result: FairQueueResult<T, K>
): result is Extract<FairQueueResult<T, K>, { eventType: "success" }> {
    return result.eventType === "success";
}

/**
 * Type guard to check if a FairQueueResult is an error result
 */
export function isError<T, K>(
    result: FairQueueResult<T, K>
): result is Extract<FairQueueResult<T, K>, { eventType: "error" }> {
    return result.eventType === "error";
}

export interface FairQueueResultListener<T, K> {
    (correlationId: string, result: FairQueueResult<T, K>): Promise<void>;
}

const REDIS_SCRIPTS = {
    fairQueueAddWithConcurrency: {
        lua: LUA_ADD_WITH_CONCURRENCY,
        numberOfKeys: 4, // queue, host, concurrency
    },
    fairQueueFindAndMove: {
        lua: LUA_FIND_AND_MOVE,
        numberOfKeys: 3, // from, to, element
    },
    fairQueueWakeUp: {
        lua: LUA_WAKE_UP,
        numberOfKeys: 2, // from, to
    },
};

declare module "ioredis" {
    interface RedisCommander<Context> {
        fairQueueAddWithConcurrency(
            queue: string,
            pendingQueue: string,
            key: string,
            concurrency: number
        ): Promise<number>;
        fairQueueFindAndMove(pendingQueue: string, queue: string, element: string): Promise<number>;
        fairQueueWakeUp(from: string, to: string): Promise<number>;
    }
}
/* eslint-enable @typescript-eslint/no-unused-vars, no-unused-vars */

export type FairQueueRedisOptions = RedisOptions;

export type FairQueueRabbitMQOptions = {
    amqpUrl: string;
    maxUrlQueueLength?: number; // process-level cap
};

export type WaitOptions = {
    timeoutMs?: number;
    signal?: AbortSignal;
};
export class FairQueue<T extends FairQueuePayload, K> extends EventEmitter {
    public prefix: string;
    public active: boolean = false;
    private activePromises = new Set<Promise<void>>();
    private redis: Redis;
    private blockingRedis: Redis;

    private conn!: ChannelModel;
    private ch!: ConfirmChannel;
    private publishConn!: ChannelModel;
    private publishCh!: ConfirmChannel;

    private readonly redisOpts: FairQueueRedisOptions;
    private readonly rabbitOpts: FairQueueRabbitMQOptions;

    private deletedPayloadCache: FairQueueCache<T>;
    private payloadCache: FairQueueCache<T>;

    private ensuredQueues = new Map<string, Promise<Replies.AssertQueue>>();

    // redis queue names
    private hostQ = () => `${FAIR_QUEUE_NAME}:${this.prefix}:hosts`;
    private hostQPending = () => `${FAIR_QUEUE_NAME}:${this.prefix}:hosts:pending`;
    // rabbitmq queue names
    private urlsQPush = (host: string) => `${FAIR_QUEUE_NAME}:${this.prefix}:push.urls.${host}`;
    private urlsQUnshift = (host: string) => `${FAIR_QUEUE_NAME}:${this.prefix}:unshift.urls.${host}`;
    public replyEx = () => `${FAIR_QUEUE_NAME}:${this.prefix}:replies`;
    public replyQ = () => `${FAIR_QUEUE_NAME}:${this.prefix}:replies:q`;

    constructor(
        prefix: string,
        redisOpts: FairQueueRedisOptions,
        rabbitOpts: FairQueueRabbitMQOptions,
        // eslint-disable-next-line no-unused-vars
        getKey?: (payload: T) => string
    ) {
        super();
        this.prefix = prefix;
        if (!getKey) {
            this.emit("warning", "No getKey function provided, using url as the unique key");
            getKey = (payload: T) => payload.url;
        }

        this.redis = new Redis({
            ...redisOpts,
            scripts: REDIS_SCRIPTS,
        });
        this.blockingRedis = new Redis({
            ...redisOpts,
            scripts: REDIS_SCRIPTS,
        });
        this.payloadCache = new RedisCache<T>(
            `${FAIR_QUEUE_NAME}:${this.prefix}:urls:`,
            redisOpts,
            getKey,
            10 * 60 * 1000
        ); // 10 minutes TTL
        this.deletedPayloadCache = new RedisCache<T>(`${FAIR_QUEUE_NAME}:${this.prefix}:deleted:`, redisOpts, getKey);
        this.redisOpts = redisOpts;
        this.rabbitOpts = {
            amqpUrl: rabbitOpts.amqpUrl,
            maxUrlQueueLength: rabbitOpts.maxUrlQueueLength ?? 1000,
            // queuePrefix: rabbitOpts.queuePrefix ?? FAIR_QUEUE_NAME,
        };

        // this.replyEx = `${FAIR_QUEUE_NAME}:${this.prefix}:replies`;
    }

    async init() {
        if (this.redisOpts.lazyConnect) {
            await this.redis.connect();
            await this.blockingRedis.connect();
            this.redis.on("error", (err) => {
                this.emit("error", new Error("Redis error", { cause: err }));
            });
            this.blockingRedis.on("error", (err) => {
                this.emit("error", new Error("Blocking Redis error", { cause: err }));
            });
        }

        this.deletedPayloadCache.on("error", (err) => {
            this.emit("error", new Error("Deleted payload cache error", { cause: err }));
        });

        const { conn, ch } = await this.connectToRabbitMQ();
        this.conn = conn;
        this.ch = ch;

        const { conn: publishConn, ch: publishCh } = await this.connectToRabbitMQ();
        this.publishConn = publishConn;
        this.publishCh = publishCh;

        await this.ensureReplyExchangeAndQueue();

        // this causes bursts of processing for hosts that were in pending queue
        // giving them more concurrency temporarily
        // this will be fixed by consequent next() and unshift() calls
        // to correct for this, an external strategy is needed
        await this.redis.fairQueueWakeUp(this.hostQPending(), this.hostQ());
        this.active = true;
    }
    async connectToRabbitMQ({ conn, ch }: { conn?: ChannelModel; ch?: ConfirmChannel } = {}): Promise<{
        conn: ChannelModel;
        ch: ConfirmChannel;
    }> {
        // reconnect logic
        if (ch) {
            ch.removeAllListeners();
            await ch.waitForConfirms().catch(() => {});
            await ch.close().catch(() => {});
        }

        if (conn) {
            conn.removeAllListeners();
            await conn.close().catch(() => {});
        }

        const newConn = await amqplib.connect(this.rabbitOpts.amqpUrl, { heardbeat: 30 });
        const newCh = await newConn.createConfirmChannel();

        // TODO: remove event listeners on old conn and ch
        // Add proper error handling
        newCh.on("error", (err) => {
            this.emit("error", new Error("Channel error", { cause: err }));
        });

        newCh.on("close", () => {
            this.emit("warning", "Channel closed");
        });

        newCh.on("return", (msg) => {
            this.emit("warning", "Message returned (unroutable)", msg);
        });

        newConn.on("error", (err) => {
            this.emit("error", new Error("Connection error", { cause: err }));
        });

        newConn.on("close", () => {
            this.emit("warning", "Connection closed");
        });

        return { conn: newConn, ch: newCh };
    }

    async ensureUrlQueue(queue: string) {
        const existingPromise = this.ensuredQueues.get(queue);
        if (existingPromise) {
            return existingPromise;
        }
        const promise = new Promise<Replies.AssertQueue>((resolve, reject) => {
            this.ch
                .assertQueue(queue, {
                    durable: true,
                    maxLength: this.rabbitOpts.maxUrlQueueLength,
                    arguments: {
                        "x-overflow": "reject-publish",
                    },
                })
                .then(resolve)
                .catch(reject);
        });
        this.ensuredQueues.set(queue, promise);
        return promise;
    }

    async ensureReplyExchangeAndQueue() {
        await this.publishCh.assertExchange(this.replyEx(), "topic", {
            durable: true,
        });
        const { queue } = await this.publishCh.assertQueue(this.replyQ(), {
            durable: true,
            arguments: {
                // job results are stored for 20 minutes
                // no customer will wait for more than that and will rather retry
                "x-message-ttl": 20 * 60 * 1000,
            },
        });
        // dispatch all replies to the reply queue
        // later, if someone wants to listen for specific correlationId,
        // they can bind their own queue to the exchange with that routing key
        await this.publishCh.bindQueue(queue, this.replyEx(), "#");
    }

    public async waitFor(
        correlationId: string,
        opts?: WaitOptions
    ): Promise<{ eventType: "success" | "error"; payload: K | Error }> {
        return new Promise<{ eventType: "success" | "error"; payload: K | Error }>((resolve, reject) => {
            (async () => {
                let timeout: NodeJS.Timeout;

                const { queue } = await this.ch.assertQueue(`${this.replyEx()}:wait.${correlationId}`, {
                    exclusive: true,
                    durable: false,
                    autoDelete: true,
                });
                await this.ch.bindQueue(queue, this.replyEx(), correlationId);

                // prettier-ignore
                const consumer = await this.ch.consume(queue, (msg) => {
                    if (msg) {
                        const payloadString = msg.content.toString();
                        const payload = JSON.parse(payloadString) as { eventType: "success" | "error"; payload: K | Error };
                        this.ch.ack(msg);
                        cleanUp();
                        resolve(payload);
                    }
                }, { noAck: false });

                const cleanUp = () => {
                    clearTimeout(timeout);
                    if (opts?.signal) {
                        opts?.signal.removeEventListener("abort", onAbort);
                    }
                    this.ch.cancel(consumer.consumerTag).catch((err) => this.emit("error", err));
                };

                const onAbort = () => {
                    cleanUp();
                    reject(new Error("Aborted"));
                };

                const onTimeout = () => {
                    cleanUp();
                    reject(new Error("Timeout"));
                };

                if (opts?.signal) {
                    opts.signal.addEventListener("abort", onAbort, { once: true });
                }

                if (opts?.timeoutMs) {
                    timeout = setTimeout(onTimeout, opts.timeoutMs);
                }
            })().catch((err) => reject(err));
        });
    }

    private async sendQ<J>(queue: string, body: J, options?: Options.Publish): Promise<void> {
        let lastChannelError: Error | null = null;
        const errorHandler = (error: Error) => (lastChannelError = error);

        this.ch.once("error", errorHandler);
        const ok = this.ch.sendToQueue(queue, Buffer.from(JSON.stringify(body)), {
            persistent: true,
            ...(options ?? {}), // correlationId, headers, etc.
        });
        if (!ok) {
            this.publishCh.removeListener("error", errorHandler);
            // to kill the worker to reduce backpressure
            throw new Error("Failed to send message to queue");
        }
        try {
            // to wait for the message to be confirmed
            // what can happen if we don't wait for confirms here?
            // the message gets queued in memory, the next() doesn't see it
            // and removes the host from the pending queue thinking it is empty
            // then the queue gets stuck
            await this.ch.waitForConfirms();
        } catch (err: unknown) {
            if (err instanceof Error && err.message === "message nacked") {
                // this happens when x-overflow is set to reject-publish
                // let's throw more meaningful error
                throw new Error("Queue is full, message dropped");
            }
            // something more serious happened, try to reconnect
            const { conn, ch } = await this.connectToRabbitMQ({
                conn: this.conn,
                ch: this.ch,
            });
            this.conn = conn;
            this.ch = ch;
            if (lastChannelError) {
                Error.captureStackTrace(lastChannelError);
                throw lastChannelError;
            }
            if (err instanceof Error) {
                Error.captureStackTrace(err);
            }
            throw err;
        } finally {
            this.ch.removeListener("error", errorHandler);
        }
    }

    private async publishEx<FairQueueResult>(
        exchange: string,
        routingKey: string,
        body: FairQueueResult,
        options?: Options.Publish
    ): Promise<void> {
        let lastChannelError: Error | null = null;
        const errorHandler = (error: Error) => (lastChannelError = error);

        this.publishCh.once("error", errorHandler);

        const ok = this.publishCh.publish(exchange, routingKey, Buffer.from(JSON.stringify(body)), {
            persistent: true,
            ...(options ?? {}), // correlationId, headers, etc.
        });
        if (!ok) {
            this.publishCh.removeListener("error", errorHandler);
            // to kill the worker to reduce backpressure
            throw new Error("Failed to publish message to exchange");
        }
        try {
            await this.publishCh.waitForConfirms();
        } catch (err) {
            const { conn, ch } = await this.connectToRabbitMQ({
                conn: this.publishConn,
                ch: this.publishCh,
            });
            this.publishConn = conn;
            this.publishCh = ch;
            if (lastChannelError) {
                Error.captureStackTrace(lastChannelError);
                throw lastChannelError;
            }
            if (err instanceof Error) {
                Error.captureStackTrace(err);
            }
            throw err;
        } finally {
            this.publishCh.removeListener("error", errorHandler);
        }
    }

    private async _push(payload: T, concurrency: number = 1, toPriorityQueue: boolean = false): Promise<string> {
        const hostname = new URL(payload.url).hostname;

        // it is not critical to have duplicates
        const notUnique = await this.payloadCache.has(payload);
        if (notUnique) {
            return "-1";
        }

        // it is not critical to have duplicates
        const isDeleted = await this.deletedPayloadCache.has(payload);
        if (isDeleted) {
            // unmark as deleted
            await this.deletedPayloadCache.delete(payload);
        }

        await this.payloadCache.set(payload);

        const correlationId = randomUUID();

        if (toPriorityQueue) {
            await this.ensureUrlQueue(this.urlsQUnshift(hostname));
            await this.sendQ(this.urlsQUnshift(hostname), payload, { correlationId });
        } else {
            await this.ensureUrlQueue(this.urlsQPush(hostname));
            await this.sendQ(this.urlsQPush(hostname), payload, { correlationId });
        }

        // add host to the rotation with specified concurrency
        // sendQ() waits for confirms to avoid race conditions when hostQ already has host,
        // but no message for it, then the host is dropped from the pending queue
        await this.redis.fairQueueAddWithConcurrency(this.hostQ(), this.hostQPending(), hostname, concurrency);

        return correlationId;
    }

    async push(payload: T, concurrency: number = 1): Promise<string> {
        return this._push(payload, concurrency, false); // to normal queue
    }

    async unshift(payload: T, concurrency: number = 1): Promise<string> {
        return this._push(payload, concurrency, true); // to priority queue
    }

    async remove(payload: T): Promise<void> {
        await this.payloadCache.delete(payload);
        await this.deletedPayloadCache.set(payload);
    }

    async purge(url: string): Promise<number> {
        try {
            const hostname = new URL(url).hostname;
            const { messageCount: count1 } = await this.ch.purgeQueue(this.urlsQPush(hostname));
            const { messageCount: count2 } = await this.ch.purgeQueue(this.urlsQUnshift(hostname));
            // no more URLs for this host
            await this.redis.lrem(this.hostQ(), 0, hostname);
            return count1 + count2;
        } catch (err) {
            this.emit("error", err);
            return 0;
        }
    }

    // public for testing only
    async release(payloadMsg: GetMessage): Promise<void> {
        const payloadString = payloadMsg.content.toString();
        const payload = JSON.parse(payloadString) as T;

        await this.payloadCache.delete(payload);
        // deleting from deletedPayloadCache is redundant
        // because release() is called only for processed jobs
        // and if the job was marked as deleted, it wouldn't be processed
        // await this.deletedPayloadCache.delete(payload);

        // order here seems to be not important
        // however, this is the prefferred order, as it avoids
        // the host being stuck in the pending queue releasing it earlier
        await this.redis.fairQueueFindAndMove(this.hostQPending(), this.hostQ(), new URL(payload.url).hostname);
        this.ch.ack(payloadMsg);
        this.emit("release", payload);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit(eventName: string | symbol, ...args: any[]): boolean {
        // this is to silence errors produced after close()
        if (eventName === "error" && !this.active) {
            return false;
        }
        return super.emit(eventName, ...args);
    }

    async processResult(concurrency: number, listener: FairQueueResultListener<T, K>): Promise<Replies.Consume> {
        const channel = await this.conn.createChannel();
        // Add proper error handling
        channel.on("error", (err) => {
            this.emit("error", new Error("Result channel error", { cause: err }));
        });

        channel.on("close", () => {
            this.emit("warning", "Result channel closed");
        });

        await channel.prefetch(concurrency);
        await this.ensureReplyExchangeAndQueue();
        return channel.consume(
            this.replyQ(),
            (msg) => {
                if (msg) {
                    // console.log("Received result message", msg);
                    const correlationId = msg.fields.routingKey;
                    const resultdString = msg.content.toString();
                    const result = JSON.parse(resultdString) as FairQueueResult<T, K>;
                    listener(correlationId, result)
                        .then(() => {
                            channel.ack(msg);
                        })
                        .catch((err) => {
                            this.emit("error", err);
                            // requeue the message, we have prefetch so we must release it
                            // give some time to not flood the logs in case of persistent error
                            setTimeout(() => channel.nack(msg, false, true), 1000);
                        });
                }
            },
            { noAck: false }
        );
    }

    // public for testing only
    async next(): Promise<{ hostname: string; payloadMsg: GetMessage; payload: T; correlationId: string }> {
        while (this.active) {
            // need to duplicate the connection because blpop is blocking the whole connection
            const hostname = await this.blockingRedis.blmove(this.hostQ(), this.hostQPending(), "LEFT", "LEFT", 0);

            if (hostname) {
                // const [, hostname] = result as [string, string];
                while (true) {
                    await this.ensureUrlQueue(this.urlsQUnshift(hostname));
                    let payloadMsg = await this.ch.get(this.urlsQUnshift(hostname), { noAck: false });
                    if (!payloadMsg) {
                        await this.ensureUrlQueue(this.urlsQPush(hostname));
                        payloadMsg = await this.ch.get(this.urlsQPush(hostname), { noAck: false });
                    }
                    if (payloadMsg) {
                        const payloadString = payloadMsg.content.toString();
                        const { correlationId } = payloadMsg.properties;
                        const payload = JSON.parse(payloadString) as T;

                        if (await this.deletedPayloadCache.has(payload)) {
                            await this.deletedPayloadCache.delete(payload);
                            //  eturne to this.hostQPending() and ack
                            await this.release(payloadMsg);
                        } else {
                            return {
                                hostname,
                                payloadMsg,
                                payload,
                                correlationId,
                            };
                        }
                    } else {
                        // no more URLs for this host
                        // it got into pending queue, so we need to remove from there as well
                        await this.redis.lrem(this.hostQPending(), 1, hostname);
                        break;
                    }
                }
            } else {
                // this will never happen, hostname is null
            }
        }
        throw new Error("Queue is not active");
    }

    async process(concurrency: number, callback: FairQueueProcessCallback<T, K>): Promise<void> {
        if (!this.active) {
            throw new Error("Queue is not active, call init() first");
        }
        while (this.active) {
            if (this.activePromises.size < concurrency) {
                try {
                    const { payloadMsg, payload, correlationId } = await this.next();

                    if (!this.active) {
                        // not sending ack, so the job
                        // will be recovered on subsequent wake up
                        break;
                    }

                    const performanceId = Math.random().toString(36).substring(2);
                    performance.mark("fair-queue:job:start:" + performanceId);

                    const promise = callback(payload)
                        .then((result: K) => {
                            if (!this.active) {
                                // not sending ack, so the job
                                // will be recovered on subsequent wake up
                                return;
                            }
                            return this.publishEx(this.replyEx(), correlationId, {
                                eventType: "success",
                                payload,
                                result,
                            });
                        })
                        .catch((err) => {
                            if (!this.active) {
                                // not sending ack, so the job
                                // will be recovered on subsequent wake up
                                return;
                            }
                            err.payload = payload;
                            // this will produce a duplicate error report
                            // but we want to know which payload caused it
                            this.emit("error", err);
                            return this.publishEx(this.replyEx(), correlationId, {
                                eventType: "error",
                                payload,
                                error: serializeError(err),
                            }).catch((err) => {
                                err.payload = payload;
                                this.emit("error", err);
                            });
                        })
                        .finally(async () => {
                            // console.log("Finished processing", payload.url, new Date());
                            if (!this.active) {
                                // not sending ack, so the job
                                // will be recovered on subsequent wake up
                                // at this stage the connections to both redis and rabbitmq are closed
                                // !!!! host stays in the pending queue
                                return;
                            }
                            await this.release(payloadMsg).catch((err) => this.emit("error", err));

                            performance.mark("fair-queue:job:end:" + performanceId);
                            performance.measure("fair-queue:job:end", {
                                detail: payload,
                                start: "fair-queue:job:start:" + performanceId,
                                end: "fair-queue:job:end:" + performanceId,
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
                // console.log("max concurrency reached, waiting for a promise to complete", new Date());
                // Set() is iterable, so this works without converting to an array
                await Promise.race(this.activePromises);
            }
        }
        // Waiting for all ongoing tasks to complete before exiting.
        // await Promise.all(this.activePromises);
    }

    async stats(): Promise<{ pending: number; total: number; urls: number }> {
        const pending = await this.redis.lrange(this.hostQPending(), 0, -1);
        const hosts = await this.redis.lrange(this.hostQ(), 0, -1);
        const urls = await this.payloadCache.size();
        return { pending: pending.length, total: pending.length + hosts.length, urls };
    }

    async close(waitForActiveJobs: boolean = false): Promise<void> {
        if (!this.active) {
            this.emit("warning", `${this.prefix} Queue is already closed`);
            return;
        }

        if (waitForActiveJobs) {
            await Promise.all(this.activePromises);
        }
        this.active = false;

        // we can't use quit here, because this.blockingRedis is blocking
        // await this.redis.quit();
        // console.log("Disconnecting...");
        // console.log("hostQ", await this.redis.lrange(this.hostQ(), 0, -1));
        // console.log("hostQPending", await this.redis.lrange(this.hostQPending(), 0, -1));
        // console.log("Pending promises:", this.activePromises.size);
        this.deletedPayloadCache.disconnect();
        this.payloadCache.disconnect();
        this.blockingRedis.disconnect();
        this.redis.disconnect();

        await this.ch.waitForConfirms().catch(() => {});
        await this.ch.close().catch(() => {});
        await this.conn.close().catch(() => {});
    }
}
