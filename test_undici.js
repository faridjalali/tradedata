const { setGlobalDispatcher, Agent, fetch } = require('undici');

const API_KEY = process.env.DATA_API_KEY || 'pig0ix6gPImcxdqhUmvTCUnjVPKVmkC0';
const URL = `https://api.massive.com/v2/aggs/ticker/SPY/range/1/day/2023-01-01/2023-01-10?apiKey=${API_KEY}`;

async function testUndici(configName, agentConfig) {
  console.log(`\n--- Testing ${configName} ---`);
  if (agentConfig) {
    const agent = new Agent(agentConfig);
    setGlobalDispatcher(agent);
  }

  try {
    const start = performance.now();
    const res = await fetch(URL);
    const text = await res.text();
    const duration = performance.now() - start;

    console.log(`Status: ${res.status}`);
    console.log(`Duration: ${duration.toFixed(2)}ms`);
    console.log(`Response length: ${text.length}`);
    if (res.status !== 200) {
       console.log('Error Body:', text.substring(0, 200));
    } else {
       console.log('Success!');
    }
  } catch (err) {
    console.error('Fetch failed:', err.message);
    if (err.cause) console.error('Cause:', err.cause);
  }
}

async function run() {
  // Test 1: Default (No custom agent - verifying baseline)
  // await testUndici('Default Undici', null);

  // Test 2: Previous problematic config (Keep-Alive)
  await testUndici('Previous Config', {
    keepAliveTimeout: 15000,
    keepAliveMaxTimeout: 30000, // This might be the culprit if server closes connection aggressively
    connect: {
        timeout: 15000
    }
  });

   // Test 3: Adjusted Config (Disabling pipelining, tuning keepalive)
  await testUndici('Adjusted Config', {
    keepAliveTimeout: 10000,
    keepAliveMaxTimeout: 10000,
    pipelining: 0,
    connect: {
        timeout: 10000
    }
  });
}

run();
