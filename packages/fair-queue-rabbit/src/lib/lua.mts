export const LUA_ADD_WITH_CONCURRENCY = `
local queue = KEYS[1]
local queue2 = KEYS[2]
local key = KEYS[3]
local concurrency = tonumber(KEYS[4])

local occurrences = redis.call('LPOS', queue, key, 'COUNT', 0)
local occurrences2 = redis.call('LPOS', queue2, key, 'COUNT', 0)
if (#occurrences + #occurrences2 < concurrency) then
    redis.call('RPUSH', queue, key)
    return 1;
end
return 0;
`;

export const LUA_FIND_AND_MOVE = `
local from = KEYS[1]
local to = KEYS[2]
local element = KEYS[3]

local result = redis.call('LREM', from, 1, element)
if (result > 0) then
    redis.call('RPUSH', to, element)
    return 1;
end
return 0;
`;

export const LUA_WAKE_UP = `
local from = KEYS[1]
local to = KEYS[2]

local moved = 0
while true do
    local res = redis.call("LMPOP", 1, from, "LEFT", "COUNT", 1000)
    if not res then
        break
    end

    local items = res[2]
    local n = #items
    if n == 0 then
        break
    end

    redis.call("RPUSH", to, unpack(items))

    moved = moved + n
end

return moved
`;
