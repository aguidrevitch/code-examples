import EventEmitter from "events";
import { FairQueueCache } from "../types/fair-queue-cache.mjs";
import { Redis, RedisOptions } from "ioredis";

export class RedisCache<T> extends EventEmitter implements FairQueueCache<T> {
    private prefix: string;
    private ttl?: number; // time to live in milliseconds
    private redis: Redis;
    // eslint-disable-next-line no-unused-vars
    private getKey: (payload: T) => string;

    // eslint-disable-next-line no-unused-vars
    constructor(prefix: string, redisOpts: RedisOptions, getKey: (payload: T) => string, ttl?: number) {
        super();
        this.prefix = prefix;
        this.ttl = ttl;
        this.redis = new Redis(redisOpts); //.on("error", (err) => this.emit("error", err));
        this.redis.on("error", (err) => this.emit("error", err));
        this.getKey = getKey;
    }

    async set(payload: T): Promise<void> {
        const key = this.getKey(payload);
        const expiryScore = this.ttl ? Date.now() + this.ttl : Number.MAX_SAFE_INTEGER;
        
        // Store in sorted set with expiry timestamp as score
        // The value parameter is ignored as per your request
        await this.redis.zadd(this.prefix, expiryScore, key);
    }

    async get(payload: T): Promise<string | null> {
        const key = this.getKey(payload);
        
        // Check if key exists and is not expired
        const score = await this.redis.zscore(this.prefix, key);
        
        if (score === null || parseInt(score) < Date.now()) {
            // Key doesn't exist or has expired
            if (score !== null) {
                // Clean up expired key
                await this.delete(payload);
            }
            return null;
        }
        
        // Return "1" as default value since we don't store actual values
        return "1";
    }

    async has(payload: T): Promise<boolean> {
        const key = this.getKey(payload);
        const score = await this.redis.zscore(this.prefix, key);
        
        // Key exists and has not expired
        if (score !== null && parseInt(score) > Date.now()) {
            return true;
        }
        
        // Clean up expired key if needed
        if (score !== null) {
            await this.delete(payload);
        }
        
        return false;
    }

    async delete(payload: T): Promise<number> {
        const key = this.getKey(payload);
        
        // Remove from sorted set
        return this.redis.zrem(this.prefix, key);
    }

    async size(): Promise<number> {
        // This is now efficient - just count valid entries
        if (this.ttl) {
            // Only count non-expired entries
            return this.redis.zcount(this.prefix, Date.now(), "+inf");
        } else {
            // Count all entries
            return this.redis.zcard(this.prefix);
        }
    }
    
    async clear(): Promise<void> {
        // Clear the sorted set
        await this.redis.del(this.prefix);
    }
    
    async cleanup(): Promise<number> {
        // Remove all expired entries
        return this.redis.zremrangebyscore(this.prefix, 0, Date.now());
    }
    
    disconnect(): void {
        this.redis.disconnect();
    }
}
