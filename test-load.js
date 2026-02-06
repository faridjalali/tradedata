const http = require('http');

const runTest = async () => {
    const successCount = { count: 0 };
    const failCount = { count: 0 };
    const promises = [];

    console.log("Starting load test with 50 concurrent requests...");

    for (let i = 0; i < 50; i++) {
        const payload = JSON.stringify({
            ticker: `TEST-${i}`,
            signalDir: 1,
            price: 100 + i,
            message: "Test Alert",
            timeframe: "1d"
        });

        const options = {
            hostname: 'localhost',
            port: 3000,
            path: '/webhook?secret=' + (process.env.WEBHOOK_SECRET || 'test_secret'),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
            }
        };

        const p = new Promise((resolve) => {
            const req = http.request(options, (res) => {
                if (res.statusCode === 200) {
                    successCount.count++;
                } else {
                    failCount.count++;
                    console.log(`Req ${i} failed: ${res.statusCode}`);
                }
                res.on('data', () => {}); // Consume stream
                res.on('end', resolve);
            });
            
            req.on('error', (e) => {
                failCount.count++;
                console.error(`Req ${i} error: ${e.message}`);
                resolve();
            });

            req.write(payload);
            req.end();
        });

        promises.push(p);
    }

    await Promise.all(promises);
    console.log(`Test Complete.`);
    console.log(`Success: ${successCount.count}`);
    console.log(`Failed: ${failCount.count}`);
};

// Wait for server to potentially start if running immediately
setTimeout(runTest, 1000);
