# IBM Cloud Code Engine - Token Refresh Deployment

## Overview

This guide provides step-by-step instructions for deploying the Carbon MCP Token Refresh API to IBM Cloud Code Engine with kubectl management.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  IBM Cloud Code Engine                                       │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │  carbon-pr-review-api (Application)                │    │
│  │  - Auto-scaling: 1-5 instances                     │    │
│  │  - Port: 3000                                      │    │
│  │  - Public endpoint with HTTPS                      │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │  carbon-pr-review-secrets (Secret)                 │    │
│  │  - API_SECRET                                      │    │
│  │  - GITHUB_AI_AGENT_TOKEN                          │    │
│  │  - BOBSHELL_API_KEY                               │    │
│  │  - CARBON_MCP_TOKEN                               │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │  carbon-pr-review-job (Job)                       │    │
│  │  - Scheduled: Every 6 hours                        │    │
│  │  - Runs PR review agent                           │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                       ▲
                       │ HTTPS
                       │
              ┌────────┴────────┐
              │  Admin/CI/CD    │
              │  Token Refresh  │
              └─────────────────┘
```

## Prerequisites

1. **IBM Cloud CLI** with Code Engine plugin
   ```bash
   # Install IBM Cloud CLI
   curl -fsSL https://clis.cloud.ibm.com/install/linux | sh
   
   # Install Code Engine plugin
   ibmcloud plugin install code-engine
   ```

2. **kubectl** (for advanced management)
   ```bash
   # macOS
   brew install kubectl
   
   # Linux
   curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
   chmod +x kubectl
   sudo mv kubectl /usr/local/bin/
   ```

3. **Docker** (for building images)
   ```bash
   docker --version
   ```

## Step 1: Login to IBM Cloud

```bash
# Login to IBM Cloud
ibmcloud login --sso

# Target your resource group
ibmcloud target -g Default

# Select region (choose closest to your users)
ibmcloud target -r us-south
```

## Step 2: Create Code Engine Project

```bash
# Create a new Code Engine project
ibmcloud ce project create --name carbon-pr-review

# Select the project
ibmcloud ce project select --name carbon-pr-review

# Get kubectl config for the project
ibmcloud ce project select --name carbon-pr-review --kubecfg
```

## Step 3: Build and Push Container Image

### Option A: Using IBM Cloud Container Registry

```bash
# Login to IBM Cloud Container Registry
ibmcloud cr login

# Create namespace (if not exists)
ibmcloud cr namespace-add carbon-pr-review

# Build and push image
docker build -t us.icr.io/carbon-pr-review/carbon-pr-review-api:latest .
docker push us.icr.io/carbon-pr-review/carbon-pr-review-api:latest

# Verify image
ibmcloud cr images --restrict carbon-pr-review
```

### Option B: Using Code Engine Build

```bash
# Create build from source
ibmcloud ce build create \
  --name carbon-pr-review-api-build \
  --source . \
  --strategy dockerfile \
  --dockerfile Dockerfile \
  --image us.icr.io/carbon-pr-review/carbon-pr-review-api:latest

# Run the build
ibmcloud ce buildrun submit --build carbon-pr-review-api-build
```

## Step 4: Create Secrets

```bash
# Generate secure API secret
API_SECRET=$(openssl rand -base64 32)

# Create secret with all credentials
ibmcloud ce secret create \
  --name carbon-pr-review-secrets \
  --from-literal API_SECRET="$API_SECRET" \
  --from-literal API_ENABLE_AUTH=true \
  --from-literal GITHUB_AI_AGENT_TOKEN="ghp_your_token_here" \
  --from-literal BOBSHELL_API_KEY="your_bob_key_here" \
  --from-literal CARBON_MCP_TOKEN="your_carbon_token_here" \
  --from-literal GITHUB_AI_AGENT_CLI=bob \
  --from-literal GITHUB_AI_AGENT_OWNER=carbon-design-system \
  --from-literal GITHUB_AI_AGENT_REPO=carbon

# Save API_SECRET for later use
echo "API_SECRET=$API_SECRET" > .api-secret
echo "⚠️  Save this API_SECRET securely!"
```

## Step 5: Deploy API Application

```bash
# Create the API application
ibmcloud ce application create \
  --name carbon-pr-review-api \
  --image us.icr.io/carbon-pr-review/carbon-pr-review-api:latest \
  --port 3000 \
  --min-scale 1 \
  --max-scale 5 \
  --cpu 0.5 \
  --memory 1G \
  --env-from-secret carbon-pr-review-secrets \
  --env API_PORT=3000

# Get the application URL
ibmcloud ce application get --name carbon-pr-review-api --output url
```

## Step 6: Test the API

```bash
# Get the API URL
API_URL=$(ibmcloud ce application get --name carbon-pr-review-api --output url)

# Load API secret
source .api-secret

# Test health endpoint (no auth required)
curl $API_URL/api/health

# Test status endpoint (requires auth)
curl -H "Authorization: Bearer $API_SECRET" \
  $API_URL/api/mcp/status

# Test token refresh
curl -X POST $API_URL/api/mcp/refresh \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"token": "new-test-token"}'
```

## Step 7: Create Scheduled Review Job

```bash
# Create job for PR reviews
ibmcloud ce job create \
  --name carbon-pr-review-job \
  --image us.icr.io/carbon-pr-review/carbon-pr-review-api:latest \
  --cpu 1 \
  --memory 2G \
  --env-from-secret carbon-pr-review-secrets \
  --command npm \
  --argument start

# Create cron subscription (every 6 hours)
ibmcloud ce subscription cron create \
  --name carbon-pr-review-schedule \
  --destination carbon-pr-review-job \
  --schedule "0 */6 * * *" \
  --data '{"trigger":"scheduled"}'

# Test job manually
ibmcloud ce jobrun submit --job carbon-pr-review-job
```

## Using kubectl for Advanced Management

### Get kubectl Context

```bash
# Configure kubectl for Code Engine project
ibmcloud ce project select --name carbon-pr-review --kubecfg

# Verify connection
kubectl get pods
kubectl get services
```

### View Resources

```bash
# List all applications
kubectl get apps

# List all jobs
kubectl get jobs

# List secrets
kubectl get secrets

# View application details
kubectl describe app carbon-pr-review-api

# View logs
kubectl logs -l app=carbon-pr-review-api --tail=100 -f
```

### Update Application with kubectl

```bash
# Get current application config
kubectl get app carbon-pr-review-api -o yaml > app.yaml

# Edit configuration
nano app.yaml

# Apply changes
kubectl apply -f app.yaml
```

### Scale Application

```bash
# Scale using Code Engine CLI
ibmcloud ce application update \
  --name carbon-pr-review-api \
  --min-scale 2 \
  --max-scale 10

# Or using kubectl
kubectl scale app carbon-pr-review-api --replicas=3
```

### Update Secrets

```bash
# Update secret using Code Engine CLI
ibmcloud ce secret update \
  --name carbon-pr-review-secrets \
  --from-literal CARBON_MCP_TOKEN="new-token-value"

# Or using kubectl
kubectl create secret generic carbon-pr-review-secrets \
  --from-literal API_SECRET="$API_SECRET" \
  --from-literal CARBON_MCP_TOKEN="new-token" \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart application to pick up new secret
ibmcloud ce application update --name carbon-pr-review-api --force
```

## Token Refresh Automation

### Option 1: Using curl from CI/CD

```bash
#!/bin/bash
# refresh-token-ibm-cloud.sh

API_URL=$(ibmcloud ce application get --name carbon-pr-review-api --output url)
source .api-secret

curl -X POST $API_URL/api/mcp/refresh \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$NEW_CARBON_TOKEN\"}"
```

### Option 2: Using IBM Cloud Functions

```javascript
// refresh-token-function.js
const https = require('https');

async function main(params) {
  const { apiUrl, apiSecret, newToken } = params;
  
  const postData = JSON.stringify({
    token: newToken,
    agent: 'bob'
  });
  
  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiSecret}`,
      'Content-Type': 'application/json',
      'Content-Length': postData.length
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request(apiUrl + '/api/mcp/refresh', options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

exports.main = main;
```

Deploy the function:
```bash
ibmcloud fn action create refresh-carbon-token refresh-token-function.js \
  --web true \
  --param apiUrl "https://your-api-url.appdomain.cloud" \
  --param apiSecret "$API_SECRET"
```

### Option 3: Scheduled Job for Token Refresh

```bash
# Create a job that refreshes the token
ibmcloud ce job create \
  --name carbon-token-refresh-job \
  --image us.icr.io/carbon-pr-review/carbon-pr-review-api:latest \
  --env-from-secret carbon-pr-review-secrets \
  --command node \
  --argument examples/refresh-token-example.js

# Schedule it monthly
ibmcloud ce subscription cron create \
  --name carbon-token-refresh-schedule \
  --destination carbon-token-refresh-job \
  --schedule "0 0 1 * *"
```

## Monitoring and Logging

### View Application Logs

```bash
# Using Code Engine CLI
ibmcloud ce application logs --name carbon-pr-review-api --follow

# Using kubectl
kubectl logs -l app=carbon-pr-review-api --tail=100 -f

# View specific pod logs
POD=$(kubectl get pods -l app=carbon-pr-review-api -o jsonpath='{.items[0].metadata.name}')
kubectl logs $POD -f
```

### View Job Logs

```bash
# List job runs
ibmcloud ce jobrun list --job carbon-pr-review-job

# View specific job run logs
ibmcloud ce jobrun logs --name carbon-pr-review-job-xxxxx

# Using kubectl
kubectl logs job/carbon-pr-review-job-xxxxx
```

### Set Up Log Analysis

```bash
# Enable IBM Log Analysis
ibmcloud resource service-instance-create \
  carbon-pr-review-logs \
  logdna \
  7-day \
  us-south

# Connect to Code Engine project
ibmcloud ce project update \
  --name carbon-pr-review \
  --log-analysis-instance carbon-pr-review-logs
```

## Troubleshooting

### Application Won't Start

```bash
# Check application status
ibmcloud ce application get --name carbon-pr-review-api

# View events
kubectl describe app carbon-pr-review-api

# Check logs
ibmcloud ce application logs --name carbon-pr-review-api --tail=100
```

### Secret Issues

```bash
# Verify secret exists
ibmcloud ce secret get --name carbon-pr-review-secrets

# List secret keys (values are hidden)
kubectl get secret carbon-pr-review-secrets -o yaml

# Recreate secret if needed
ibmcloud ce secret delete --name carbon-pr-review-secrets --force
# Then recreate with Step 4 commands
```

### Token Refresh Fails

```bash
# Check API logs
kubectl logs -l app=carbon-pr-review-api | grep "refresh"

# Test API endpoint
curl -v $API_URL/api/mcp/status \
  -H "Authorization: Bearer $API_SECRET"

# Check if Bob is available in container
kubectl exec -it $(kubectl get pods -l app=carbon-pr-review-api -o jsonpath='{.items[0].metadata.name}') \
  -- bob --version
```

## Cost Optimization

### Auto-scaling Configuration

```bash
# Keep at least one instance resident — do NOT set --min-scale 0. This app runs a
# background timer that renews the Carbon MCP token before it expires; an instance
# scaled to zero runs no timer, so the connection lapses and reviews fail. Tune the
# ceiling for load, but the floor stays at 1.
ibmcloud ce application update \
  --name carbon-pr-review-api \
  --min-scale 1 \
  --max-scale 5 \
  --scale-down-delay 300

# Set concurrency limits
ibmcloud ce application update \
  --name carbon-pr-review-api \
  --concurrency 100 \
  --concurrency-target 80
```

### Resource Limits

```bash
# Optimize CPU and memory
ibmcloud ce application update \
  --name carbon-pr-review-api \
  --cpu 0.25 \
  --memory 512M
```

## Security Best Practices

1. **Rotate API Secret Regularly**
   ```bash
   # Generate new secret
   NEW_API_SECRET=$(openssl rand -base64 32)
   
   # Update secret
   ibmcloud ce secret update \
     --name carbon-pr-review-secrets \
     --from-literal API_SECRET="$NEW_API_SECRET"
   
   # Restart application
   ibmcloud ce application update --name carbon-pr-review-api --force
   ```

2. **Use Private Endpoints** (if available)
   ```bash
   ibmcloud ce application update \
     --name carbon-pr-review-api \
     --visibility private
   ```

3. **Enable Audit Logging**
   ```bash
   # View audit events
   ibmcloud ce project events --name carbon-pr-review
   ```

## Cleanup

```bash
# Delete application
ibmcloud ce application delete --name carbon-pr-review-api --force

# Delete job
ibmcloud ce job delete --name carbon-pr-review-job --force

# Delete subscriptions
ibmcloud ce subscription cron delete --name carbon-pr-review-schedule --force

# Delete secrets
ibmcloud ce secret delete --name carbon-pr-review-secrets --force

# Delete project (removes everything)
ibmcloud ce project delete --name carbon-pr-review --force
```

## Summary

You now have:
- ✅ API server running on IBM Cloud Code Engine
- ✅ Automatic HTTPS endpoint
- ✅ Secure secret management
- ✅ Scheduled PR review jobs
- ✅ kubectl access for advanced management
- ✅ Token refresh capability via API

**Next Steps:**
1. Set up monitoring and alerting
2. Configure automated token refresh
3. Test end-to-end PR review workflow
4. Document your specific token refresh schedule

## Support

- IBM Cloud Code Engine Docs: https://cloud.ibm.com/docs/codeengine
- kubectl Reference: https://kubernetes.io/docs/reference/kubectl/
- Token Refresh API: [`docs/TOKEN_REFRESH_API.md`](../docs/TOKEN_REFRESH_API.md)