# Marabu Node
[![CI](https://github.com/giannistbs/marabu-node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/giannistbs/marabu-node/actions/workflows/ci.yml)

You can deploy this node in a Docker container using the following command:

```bash
docker compose up -d
```

## Tests

Run the full test suite after installing dependencies:

```bash
npm test
```

## Deployments

- Pushing to the `main` branch runs CI and deploys the latest code to the main Vultr server at `78.141.219.35`.  
- Pushing to the `staging` branch runs CI and deploys the latest code to the staging AWS EC2 instance at `13.49.72.160`.
