const http = require('http');

const TEST_DATA = {
  annotations: [
    {
      id: 'test-lane-1',
      name: 'Palm Drive',
      type: 'lane',
      points: [
        { lat: 37.4265, lng: -122.1680 },
        { lat: 37.4270, lng: -122.1685 },
        { lat: 37.4275, lng: -122.1690 }
      ]
    },
    {
      id: 'test-lane-2',
      name: 'Palm Drive',
      type: 'lane',
      points: [
        { lat: 37.4264, lng: -122.1679 },
        { lat: 37.4269, lng: -122.1684 },
        { lat: 37.4274, lng: -122.1689 }
      ]
    }
  ],
  eraserPoints: [
    { id: 'eraser-1', lat: 37.42695, lng: -122.16845, radius: 10 },
    { id: 'eraser-2', lat: 37.42670, lng: -122.16820, radius: 5 }
  ],
  metadata: {
    savedAt: new Date().toISOString(),
    campus: 'Stanford University',
    project: 'FollowRTK Self-Driving Golf Cart'
  }
};

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  let passed = 0, failed = 0;

  function assert(condition, msg) {
    if (condition) { console.log(`  PASS: ${msg}`); passed++; }
    else { console.log(`  FAIL: ${msg}`); failed++; }
  }

  console.log('\n=== Save/Load API Tests ===\n');

  console.log('Test 1: Save lanes with erasers');
  const saveRes = await request('POST', '/api/save', TEST_DATA);
  assert(saveRes.status === 200, 'Save returns 200');
  assert(saveRes.body.success === true, 'Save returns success');
  assert(saveRes.body.count === 2, 'Reports 2 annotations');

  console.log('\nTest 2: Load lanes with erasers');
  const loadRes = await request('GET', '/api/load');
  assert(loadRes.status === 200, 'Load returns 200');
  assert(loadRes.body.annotations.length === 2, '2 lane annotations loaded');
  assert(loadRes.body.eraserPoints.length === 2, '2 eraser points loaded');

  console.log('\nTest 3: Verify lane data');
  const lane1 = loadRes.body.annotations.find(a => a.id === 'test-lane-1');
  assert(lane1 !== undefined, 'Lane 1 found');
  assert(lane1.name === 'Palm Drive', 'Name preserved');
  assert(lane1.type === 'lane', 'Type is "lane"');
  assert(lane1.points.length === 3, '3 points preserved');
  assert(lane1.points[0].lat === 37.4265, 'Lat preserved');
  assert(lane1.points[0].lng === -122.1680, 'Lng preserved');

  const lane2 = loadRes.body.annotations.find(a => a.id === 'test-lane-2');
  assert(lane2 !== undefined, 'Lane 2 found');
  assert(lane2.name === 'Palm Drive', 'Same road name for pairing');

  console.log('\nTest 4: Verify eraser data');
  const e1 = loadRes.body.eraserPoints.find(e => e.id === 'eraser-1');
  assert(e1 !== undefined, 'Eraser 1 found');
  assert(e1.lat === 37.42695, 'Eraser lat preserved');
  assert(e1.lng === -122.16845, 'Eraser lng preserved');
  assert(e1.radius === 10, 'Eraser radius preserved');

  console.log('\nTest 5: Invalid data rejected');
  const badRes = await request('POST', '/api/save', { bad: 'data' });
  assert(badRes.status === 400, 'Returns 400');

  console.log('\nTest 6: Overwrite and verify');
  const newData = {
    annotations: [{ id: 'x', name: 'Serra Mall', type: 'lane', points: [{ lat: 37.427, lng: -122.170 }] }],
    eraserPoints: [],
    metadata: { savedAt: new Date().toISOString(), campus: 'Stanford University', project: 'test' }
  };
  await request('POST', '/api/save', newData);
  const reload = await request('GET', '/api/load');
  assert(reload.body.annotations.length === 1, 'Overwrite: 1 annotation');
  assert(reload.body.annotations[0].name === 'Serra Mall', 'Overwrite: name correct');
  assert(reload.body.eraserPoints.length === 0, 'Overwrite: 0 erasers');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => { console.error('Test error:', err.message); process.exit(1); });
