# AgentForge

**An AI coding agent that verifies its own changes.**

AgentForge is an experimental TypeScript project exploring AI-assisted software development through controlled file changes and independent verification in Docker.

## How it works

1. Receives a coding task and context from explicitly selected workspace files.
2. Requests structured file-change proposals from an AI model.
3. Validates proposed changes before applying them inside the workspace.
4. Runs configured checks in a restricted Docker container.
5. Can pass verification failures back to the agent for a bounded repair attempt.
6. Returns a structured report with status, attempts, and verification results.

## Current features

- TypeScript and Node.js
- OpenAI API integration using the official SDK and Responses API
- Structured JSON proposals for file creation and replacement
- Workspace-scoped file changes with path validation and size limits
- Bounded workspace context
- Docker-based verification with network and resource restrictions
- Bounded retry workflow
- Unit and integration tests
- CLI smoke test using the real OpenAI API
- CLI repair demo using the real OpenAI API

## Requirements

- Node.js and npm
- Docker running locally
- An OpenAI API key with API billing enabled

## Getting started

Install dependencies:

```bash
npm install
```

Set your own API credentials in the environment:

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_MODEL="your-supported-model"
```

Never commit API keys or other secrets.

Build the project:

```bash
npm run build
```

Run the tests (this also builds the project):

```bash
npm test
```

Run the smoke test:

```bash
npm start -- --openai-smoke
```

The smoke test makes a real API request, creates a temporary workspace, proposes a file change, and verifies the result in Docker. It may incur API charges. ChatGPT subscriptions and API billing are separate.

Run the repair demo:

```bash
npm start -- --openai-repair-demo
```

Optionally save its report with `npm start -- --openai-repair-demo --report ./repair-demo-report.json`. The demo creates a temporary workspace with an intentionally incorrect text file and a content check, then uses the Orchestrator's bounded repair workflow. It reports a successful demo only when verification fails and then passes after a repair. The temporary workspace is removed after the run. This mode makes real API requests and may incur API charges; it makes no requests beyond the Orchestrator's initial attempt and its maximum of two repairs.

## Security

AgentForge validates proposed paths and restricts file changes to a designated workspace. Verification commands are configured by the application, and Docker execution uses restricted networking and resource limits.

These safeguards reduce risk but do not guarantee complete isolation or eliminate every filesystem race condition. This prototype has not been hardened for sensitive projects or untrusted workloads.

## Current status

The first end-to-end smoke test has successfully used the OpenAI API to propose a file change and pass sandbox verification.

The project remains an early-stage prototype. Repair behavior and broader real-world coding tasks need further validation.

## Roadmap

- [ ] Validate a complete repair cycle after a deliberately failing check
- [ ] Test changes across multiple related source files
- [ ] Improve diagnostics and reporting
- [ ] Add documented example tasks and sample reports
- [ ] Evaluate additional security controls

## License

No license has been added yet. Until a license is selected, no permission to reuse, modify, or redistribute this code is granted.
