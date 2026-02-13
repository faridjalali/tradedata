const { barsToTuples, pointsToTuples } = require('./server/chartMath');

const mockBars = [
  { time: 1000, open: 10, high: 15, low: 5, close: 12, volume: 100 },
  { time: 2000, open: 12, high: 18, low: 11, close: 15, volume: 200 }
];

const mockPoints = [
  { time: 1000, value: 50 },
  { time: 2000, value: 60 }
];

const tuples = barsToTuples(mockBars);
console.log('Bars Tuples:', JSON.stringify(tuples));

if (tuples.length !== 2 || tuples[0].length !== 6) {
  console.error('Bars tuple conversion failed');
  process.exit(1);
}

const points = pointsToTuples(mockPoints);
console.log('Points Tuples:', JSON.stringify(points));

if (points.length !== 2 || points[0].length !== 2) {
  console.error('Points tuple conversion failed');
  process.exit(1);
}

console.log('Backend tuple logic verified.');
