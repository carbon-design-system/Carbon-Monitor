/**
 * Test token usage estimation
 */

const { estimateTokenUsage } = require('../src/reviewPrompt');

console.log('🧪 Testing Token Usage Estimation\n');

// Test 1: Typical PR review
console.log('Test 1: Typical PR review');
const prompt = 'Review this PR for issues.'.repeat(100); // ~2,700 chars
const diff = '+const x = 1;\n-const y = 2;\n'.repeat(50); // ~1,000 chars
const agentOutput = 'The code looks good. No issues found.'.repeat(20); // ~760 chars

const usage = estimateTokenUsage({ prompt, diff, agentOutput });

console.log(`  Input tokens: ${usage.input}`);
console.log(`  Output tokens: ${usage.output}`);
console.log(`  Total tokens: ${usage.total}`);

if (usage.input > 900 && usage.output > 180 && usage.total === usage.input + usage.output) {
  console.log('  ✅ PASS\n');
} else {
  console.log('  ❌ FAIL\n');
  process.exit(1);
}

// Test 2: Empty inputs
console.log('Test 2: Empty inputs');
const emptyUsage = estimateTokenUsage({ prompt: '', diff: '', agentOutput: '' });

console.log(`  Input tokens: ${emptyUsage.input}`);
console.log(`  Output tokens: ${emptyUsage.output}`);
console.log(`  Total tokens: ${emptyUsage.total}`);

if (emptyUsage.input === 0 && emptyUsage.output === 0 && emptyUsage.total === 0) {
  console.log('  ✅ PASS\n');
} else {
  console.log('  ❌ FAIL\n');
  process.exit(1);
}

// Test 3: Missing inputs
console.log('Test 3: Missing inputs');
const missingUsage = estimateTokenUsage({});

console.log(`  Input tokens: ${missingUsage.input}`);
console.log(`  Output tokens: ${missingUsage.output}`);
console.log(`  Total tokens: ${missingUsage.total}`);

if (missingUsage.input === 0 && missingUsage.output === 0 && missingUsage.total === 0) {
  console.log('  ✅ PASS\n');
} else {
  console.log('  ❌ FAIL\n');
  process.exit(1);
}

// Test 4: Rounding up
console.log('Test 4: Rounding up token counts');
const roundUsage = estimateTokenUsage({ 
  prompt: '1234567890', // 10 chars = 2.5 tokens, should round up to 3
  diff: '', 
  agentOutput: '' 
});

console.log(`  Input tokens: ${roundUsage.input}`);

if (roundUsage.input === 3) {
  console.log('  ✅ PASS\n');
} else {
  console.log('  ❌ FAIL\n');
  process.exit(1);
}

console.log('✅ All token usage tests passed!');
