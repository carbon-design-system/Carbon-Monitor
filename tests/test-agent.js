#!/usr/bin/env node

/**
 * Runs a REAL review and posts to GitHub. Run deliberately: npm run test:live
 * Test script for Carbon PR Review Agent
 * Verifies environment configuration and runs a test review
 */

require('dotenv').config();

async function testAgent() {
  console.log('🧪 Carbon PR Review Agent - Test Suite\n');
  console.log('='.repeat(80));
  
  // 1. Check environment variables
  console.log('\n1️⃣  Checking Environment Configuration...\n');
  
  const requiredVars = [
    'GITHUB_AI_AGENT_TOKEN',
    'GITHUB_AI_AGENT_CLI'
  ];
  
  const optionalVars = [
    'GITHUB_AI_AGENT_OWNER',
    'GITHUB_AI_AGENT_REPO',
    'GITHUB_AI_AGENT_MAX_PRS',
    'GITHUB_AI_AGENT_DAYS_BACK',
    'GITHUB_AI_AGENT_REVIEW_LABEL'
  ];
  
  let allRequired = true;
  
  for (const varName of requiredVars) {
    const value = process.env[varName];
    if (value) {
      console.log(`   ✅ ${varName}: Set`);
    } else {
      console.log(`   ❌ ${varName}: Not set (REQUIRED)`);
      allRequired = false;
    }
  }
  
  console.log();
  for (const varName of optionalVars) {
    const value = process.env[varName];
    if (value) {
      console.log(`   ✅ ${varName}: ${value}`);
    } else {
      console.log(`   ⚠️  ${varName}: Not set (using default)`);
    }
  }
  
  if (!allRequired) {
    console.error('\n❌ Missing required environment variables');
    console.error('Please copy .env.example to .env and configure it');
    process.exit(1);
  }
  
  // 2. Check agent-specific API keys
  console.log('\n2️⃣  Checking Agent API Keys...\n');
  
  const agent = process.env.GITHUB_AI_AGENT_CLI;
  console.log(`   Selected agent: ${agent}`);
  
  if (agent === 'bob') {
    if (process.env.BOB_API_KEY) {
      console.log('   ✅ BOB_API_KEY: Set');
    } else {
      console.log('   ❌ BOB_API_KEY: Not set (required for Bob)');
      allRequired = false;
    }
  } else if (agent === 'claude') {
    if (process.env.ANTHROPIC_API_KEY) {
      console.log('   ✅ ANTHROPIC_API_KEY: Set');
    } else {
      console.log('   ❌ ANTHROPIC_API_KEY: Not set (required for Claude)');
      allRequired = false;
    }
  }
  
  if (!allRequired) {
    console.error('\n❌ Missing required API key for selected agent');
    process.exit(1);
  }
  
  // 3. Check if agent is available
  console.log('\n3️⃣  Checking Agent Availability...\n');
  
  const { isAgentAvailable } = require('../src/agentRunner');
  const available = await isAgentAvailable(agent);
  
  if (available) {
    console.log(`   ✅ ${agent} CLI is available in PATH`);
  } else {
    console.log(`   ❌ ${agent} CLI not found in PATH`);
    console.log(`   Please install ${agent} CLI tool`);
    process.exit(1);
  }
  
  // 4. Test GitHub connection
  console.log('\n4️⃣  Testing GitHub Connection...\n');
  
  try {
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: process.env.GITHUB_AI_AGENT_TOKEN });
    
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`   ✅ Connected as: ${user.login}`);
    
    const owner = process.env.GITHUB_AI_AGENT_OWNER || 'carbon-design-system';
    const repo = process.env.GITHUB_AI_AGENT_REPO || 'carbon';
    
    const { data: repository } = await octokit.rest.repos.get({ owner, repo });
    console.log(`   ✅ Repository accessible: ${repository.full_name}`);
    
  } catch (error) {
    console.log(`   ❌ GitHub connection failed: ${error.message}`);
    process.exit(1);
  }
  
  // 5. Run the agent
  console.log('\n5️⃣  Running Carbon PR Review Agent...\n');
  console.log('='.repeat(80));
  
  const { reviewPRs } = require('../src/index');
  
  try {
    await reviewPRs();
    console.log('\n' + '='.repeat(80));
    console.log('✅ Test completed successfully!');
    console.log('='.repeat(80) + '\n');
  } catch (error) {
    console.error('\n' + '='.repeat(80));
    console.error('❌ Test failed:', error.message);
    console.error('='.repeat(80) + '\n');
    console.error(error.stack);
    process.exit(1);
  }
}

// Run test
testAgent().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
