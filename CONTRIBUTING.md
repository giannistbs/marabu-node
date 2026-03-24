# Contributing

These are the steps we will follow as a team to commit to the node:

1. Work on a feature branch on your machine.
2. Merge into `staging` to test on the staging server.
3. Merge into `main` to deploy to production.

## Branch Workflow

1. Create a feature branch from `staging` or `main`:
   ```bash
   git checkout staging
   git pull
   git checkout -b feature/<short-description>
   ```

2. Do your work and push:
   ```bash
   git add .
   git commit -m "<description>"
   git push -u origin feature/<short-description>
   ```

3. Open a PR targeting `staging` or `main`.
   - CI will run automatically.
   - When merged to `staging`, code deploys to the small AWS EC2 staging server at `13.49.72.160`.
   - When merged to `main`, code deploys to the main Vultr server at `78.141.219.35`.