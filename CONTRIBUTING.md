# Contributing

Follow these steps to contribute to the project:

1. Work on a feature branch on your machine.
2. Merge into `staging` to test on the staging server.
3. Merge into `main` to deploy to production.

## Branch Workflow

1. Create a feature branch from `staging`:
   ```bash
   git checkout staging
   git pull
   git checkout -b feature/<short-description>
   ```

2. Do your work and push:
   ```bash
   git add .
   git commit -m "feat: <short description>"
   git push -u origin feature/<short-description>
   ```

3. Open a PR targeting `staging`.
   - CI runs automatically.
   - When merged to `staging`, code deploys to the small AWS EC2 staging server at `13.49.72.160`.

4. Verify on staging, then open a PR from `staging` to `main`.
   - When merged to `main`, code deploys to the main Vultr server at `78.141.219.35`.