import { FAIR_QUEUE_NAME } from "./constants.mjs";

export const LUA_UNSHIFT = `
local mainQueue = '${FAIR_QUEUE_NAME}:' .. KEYS[1]
local hostname = KEYS[2]
local payload = KEYS[3]
local hostnameConcurrency = tonumber(KEYS[4])
local urlQueue = mainQueue .. ':' .. hostname
local pendingHostsQueue = mainQueue .. ':pending-hosts'

local mainQueueOccurrences = redis.call('LPOS', mainQueue, hostname, 'COUNT', 0)
local pendingHostsQueueOccurrences = redis.call('LPOS', pendingHostsQueue, hostname, 'COUNT', 0)

-- this code handles the case when hostnameConcurrency gets decreased for some reason
-- then we will clean up both main and pendingHostsQueue queue
if (#mainQueueOccurrences + #pendingHostsQueueOccurrences > hostnameConcurrency) then
    redis.call('PUBLISH', 'log', 'LUA_UNSHIFT ' .. hostname .. ': decreasing concurrency from ' .. (#mainQueueOccurrences + #pendingHostsQueueOccurrences) .. ' to ' .. hostnameConcurrency .. ', wiping pendingHostsQueue and mainQueue')
    -- this is perfectly safe to remove the host from the main queue
    redis.call('LREM', mainQueue, 0, hostname)
    redis.call('LREM', pendingHostsQueue, 0, hostname)
    mainQueueOccurrences = {}
    pendingHostsQueueOccurrences = {}
end

-- # stands for length of the list
if (#mainQueueOccurrences + #pendingHostsQueueOccurrences < hostnameConcurrency) then
    redis.call('PUBLISH', 'log', 'LUA_UNSHIFT ' .. hostname .. ': adding to main queue')
    redis.call('LPUSH', mainQueue, hostname)
end

-- If payload doesn't exists in the host queue, put into host queue
-- to avoid duplicate payload in the host queue
if not redis.call('LPOS', urlQueue, payload) then
    redis.call('LPUSH', urlQueue, payload)
    redis.call('PUBLISH', 'log', 'LUA_PUSH ' .. hostname .. ': push ' .. payload)
    return 1;
end

return 0;
`;

export const LUA_PUSH = `
local mainQueue = '${FAIR_QUEUE_NAME}:' .. KEYS[1]
local hostname = KEYS[2]
local payload = KEYS[3]
local hostnameConcurrency = tonumber(KEYS[4])
local urlQueue = mainQueue .. ':' .. hostname
local pendingHostsQueue = mainQueue .. ':pending-hosts'

local mainQueueOccurrences = redis.call('LPOS', mainQueue, hostname, 'COUNT', 0)
local pendingHostsQueueOccurrences = redis.call('LPOS', pendingHostsQueue, hostname, 'COUNT', 0)

-- this code handles the case when hostnameConcurrency gets decreased for some reason
-- then we will clean up both main and pendingHostsQueue queue
if (#mainQueueOccurrences + #pendingHostsQueueOccurrences > hostnameConcurrency) then
    redis.call('PUBLISH', 'log', 'LUA_PUSH ' .. hostname .. ': decreasing concurrency from ' .. (#mainQueueOccurrences + #pendingHostsQueueOccurrences) .. ' to ' .. hostnameConcurrency .. ', wiping pendingHostsQueue and mainQueue')
    -- this is perfectly safe to remove the host from the main queue
    redis.call('LREM', mainQueue, 0, hostname)
    redis.call('LREM', pendingHostsQueue, 0, hostname)
    mainQueueOccurrences = {}
    pendingHostsQueueOccurrences = {}
end

-- # stands for length of the list
if (#mainQueueOccurrences + #pendingHostsQueueOccurrences < hostnameConcurrency) then
    redis.call('PUBLISH', 'log', 'LUA_PUSH ' .. hostname .. ': adding to main queue, hostnameConcurrency ' .. hostnameConcurrency)
    redis.call('RPUSH', mainQueue, hostname)
end

-- If payload doesn't exists in the host queue, put into host queue
-- to avoid duplicate payload in the host queue
if not redis.call('LPOS', urlQueue, payload) then
    redis.call('RPUSH', urlQueue, payload)
    redis.call('PUBLISH', 'log', 'LUA_PUSH ' .. hostname .. ': push ' .. payload)
    return 1;
end

return 0;
`;

export const LUA_REMOVE = `
local mainQueue = '${FAIR_QUEUE_NAME}:' .. KEYS[1]
local hostname = KEYS[2]
local urlQueue = mainQueue .. ':' .. hostname

local length = redis.call('LLEN', urlQueue)
-- remove the host from the main queue
redis.call('LREM', mainQueue, 0, hostname)
-- do not remove from pending hosts queue
-- to allow job to finish
-- remove the host queue if it's empty
redis.call('DEL', urlQueue)

return length;
`;

export const LUA_NEXT = `
local mainQueue = '${FAIR_QUEUE_NAME}:' .. KEYS[1]
local machineId = KEYS[2]
local hostname = KEYS[3]
local urlQueue = mainQueue .. ':' .. hostname
local pendingHostsQueue = mainQueue .. ':pending-hosts'
local pendingPayloadsQueue = mainQueue .. ':' .. machineId .. ':pending-payloads'

local payload = redis.call('LPOP', urlQueue)

if payload then
    redis.call('PUBLISH', 'log', 'LUA_NEXT ' .. hostname .. ': pop ' .. payload)
    -- add the host to the pending list
    -- we dont need this this RPUSH because it was already done 
    -- in javascript by BLMOVE mainQueue pendingHostsQueue LEFT RIGHT
    -- redis.call('RPUSH', pendingHostsQueue, hostname)
    redis.call('RPUSH', pendingPayloadsQueue, payload)
    redis.call('PUBLISH', 'log', 'LUA_NEXT ' .. hostname .. ': pendingHostsQueue ' .. table.concat(redis.call('LRANGE', pendingHostsQueue, 0, -1) or {}, ','))
    redis.call('PUBLISH', 'log', 'LUA_NEXT ' .. hostname .. ': pendingPayloadsQueue ' .. table.concat(redis.call('LRANGE', pendingPayloadsQueue, 0, -1) or {}, ','))
else 
    redis.call('PUBLISH', 'log', 'LUA_NEXT ' .. hostname .. ': no payload, clearing pendingHostsQueue and mainQueue')
    -- if there are no payloads, clear pending hosts and main queue
    redis.call('DEL', urlQueue)
    redis.call('LREM', pendingHostsQueue, 1, hostname)
    redis.call('LREM', mainQueue, 0, hostname)
end

return payload;
`;

// this is called when processing of the payload is finished
// we want to move the host from pending to main queue
// and remove the payload from pendingPayloadsQueue
export const LUA_RELEASE = `
local mainQueue = '${FAIR_QUEUE_NAME}:' .. KEYS[1]
local machineId = KEYS[2]
local hostname = KEYS[3]
local payload = KEYS[4]
local urlQueue = mainQueue .. ':' .. hostname
local pendingHostsQueue = mainQueue .. ':pending-hosts'
local pendingPayloadsQueue = mainQueue .. ':' .. machineId .. ':pending-payloads'

local mainQueueOccurrences = redis.call('LPOS', mainQueue, hostname, 'COUNT', 0)
local pendingHostsQueueOccurrences = redis.call('LPOS', pendingHostsQueue, hostname, 'COUNT', 0)
local urlQueueLength = redis.call('LLEN', urlQueue) 
  -- + redis.call('LLEN', pendingPayloadsQueue)

redis.call('PUBLISH', 'log', 'LUA_RELEASE ' .. hostname .. ': mainQueue ' .. table.concat(redis.call('LRANGE', mainQueue, 0, -1) or {}, ','))
redis.call('PUBLISH', 'log', 'LUA_RELEASE ' .. hostname .. ': pendingHostsQueue ' .. table.concat(redis.call('LRANGE', pendingHostsQueue, 0, -1) or {}, ','))
redis.call('PUBLISH', 'log', 'LUA_RELEASE ' .. hostname .. ': urlQueue ' .. table.concat(redis.call('LRANGE', urlQueue, 0, -1) or {}, ','))
redis.call('PUBLISH', 'log', 'LUA_RELEASE ' .. hostname .. ': urlQueueLength ' .. urlQueueLength .. ' #mainQueueOccurrences ' .. #mainQueueOccurrences .. ' #pendingHostsQueueOccurrences ' .. #pendingHostsQueueOccurrences)
redis.call('PUBLISH', 'log', 'LUA_RELEASE ' .. hostname .. ': pendingPayloadsQueue ' .. table.concat(redis.call('LRANGE', pendingPayloadsQueue, 0, -1) or {}, ','))

-- remove from pendingHostsQueue and add to main queue
local removed = redis.call('LREM', pendingHostsQueue, 1, hostname)
redis.call('PUBLISH', 'log', 'LUA_RELEASE (' .. removed .. ') ' .. hostname .. ': removed ' .. removed .. ' from pendingHostsQueue')
local removedPayload = redis.call('LREM', pendingPayloadsQueue, 1, payload)
redis.call('PUBLISH', 'log', 'LUA_RELEASE (' .. removedPayload ..  ') ' .. payload .. ': removed ' .. removed .. ' from pendingPayloadsQueue')

-- let's return the host to the main queue
-- if there are less urls in the queue than the sum of main and pending hosts
-- eg, if urlQueueLength is 1 and we have 1 in mainQueueOccurrences and 1 in pendingHostsQueueOccurrences (now total 1, as we removed from pending)
-- then we don't need to add the host to the main queue
-- eg if urlQueueLength is 2 and we have 1 in mainQueueOccurrences and 1 in pendingHostsQueueOccurrences (now total 1, as we removed from pending)
-- then we need to add the host to the main queue, so there will be 2 in the main queue
if removed > 0 and urlQueueLength >= #mainQueueOccurrences + #pendingHostsQueueOccurrences then
    -- IMPORTANT: if there are N copies of the same host in the system
    -- these N will be rotated from main to pending and back to main
    -- without possibility to reduce the number of copies
    -- handling for this case is in LUA_NEXT
    redis.call('PUBLISH', 'log', 'LUA_RELEASE ' .. hostname .. ': adding back to main queue')
    redis.call('RPUSH', mainQueue, hostname)
end

`;

export const LUA_CONCURRENCY = `
local mainQueue = '${FAIR_QUEUE_NAME}:' .. KEYS[1]
local hostname = KEYS[2]
local pendingHostsQueue = mainQueue .. ':pending-hosts'

local mainQueueOccurrences = redis.call('LPOS', mainQueue, hostname, 'COUNT', 0)
local pendingHostsQueueOccurrences = redis.call('LPOS', pendingHostsQueue, hostname, 'COUNT', 0)

return #mainQueueOccurrences + #pendingHostsQueueOccurrences
`;
