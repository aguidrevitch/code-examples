import EventEmitter from "events";

/* eslint-disable no-unused-vars */
export interface FairQueueCache<T> extends EventEmitter {
    set(payload: T): Promise<void>;
    has(payload: T): Promise<boolean>;
    delete(payload: T): Promise<number>;
    size(): Promise<number>;
    clear(): Promise<void>;
    disconnect(): void;
}
