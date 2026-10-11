import assert from 'node:assert/strict';
const previous={resultEventMs:120,iteratorSettledMs:130},current={},foreign={resultEventMs:999,iteratorSettledMs:999};const proof={queries:[previous,current,foreign]};const queryRequests=new Map([[previous,{request:1,actor:1,responseBodyTerminalMs:30,requestStartedMs:0}],[current,{request:3,actor:1,requestStartedMs:40}],[foreign,{request:2,actor:2,requestStartedMs:20}]]);
function calculate(){
proof.queryLifecycle = [...queryRequests].map(([row, request]) => {
      const previous = [...queryRequests].filter(([, prior]) => prior.actor === request.actor && prior.request < request.request).sort((left, right) => right[1].request - left[1].request)[0]
      return { query: proof.queries.indexOf(row) + 1, request: request.request, actor: request.actor, priorRequest: previous?.[1].request ?? null,
        priorHttpBodyCompleteBeforeRequest: previous ? Number.isFinite(previous[1].responseBodyTerminalMs) && previous[1].responseBodyTerminalMs <= request.requestStartedMs : null,
        priorResultOverlapMs: previous && Number.isFinite(previous[0].resultEventMs) ? Math.max(0, previous[0].resultEventMs - request.requestStartedMs) : null,
        priorIteratorOverlapMs: previous && Number.isFinite(previous[0].iteratorSettledMs) ? Math.max(0, previous[0].iteratorSettledMs - request.requestStartedMs) : null }
    })
    return proof.queryLifecycle;}
const rows=calculate();assert.deepEqual(rows[1],{query:2,request:3,actor:1,priorRequest:1,priorHttpBodyCompleteBeforeRequest:true,priorResultOverlapMs:80,priorIteratorOverlapMs:90});assert.equal(rows[2].priorRequest,null);assert.equal(rows[0].priorIteratorOverlapMs,null);previous.resultEventMs=20;previous.iteratorSettledMs=25;assert.equal(calculate()[1].priorIteratorOverlapMs,0);delete previous.iteratorSettledMs;assert.equal(calculate()[1].priorIteratorOverlapMs,null);previous.resultEventMs=Infinity;assert.equal(calculate()[1].priorResultOverlapMs,null);console.log(JSON.stringify({controls:6,pass:true,actualFrozenExpression:true}));
