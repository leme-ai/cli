# Leme CLI

Command-line access to Leme project integrations for coding agents and scripts.

## Usage

Authenticate with a personal access token from the Leme web app:

```bash
npx @lemeai/cli@latest login --token <token>
```

Check the authenticated project:

```bash
npx @lemeai/cli@latest whoami
```

List available tools:

```bash
npx @lemeai/cli@latest tools
```

Generate local agent instructions and skills for Codex and Claude:

```bash
npx @lemeai/cli@latest init --agents-md
```

Call a tool:

```bash
npx @lemeai/cli@latest call <sdkName> '<json>'
```

For large responses, write the full output to a file:

```bash
npx @lemeai/cli@latest call <sdkName> '<json>' --output result.json
```

## Configuration

The CLI stores login state in the user config directory. You can also provide
credentials through environment variables:

```bash
LEME_API_TOKEN=<token>
LEME_API_BASE=https://app.leme.ai/api
```

`LEME_API_BASE` is optional for production use.

## Requirements

Node.js 20 or newer.

## License

Apache-2.0
