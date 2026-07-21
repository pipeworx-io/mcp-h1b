# mcp-h1b

US H-1B visa sponsorship & LCA wage data — does a company sponsor, and what they pay per role

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1339+ live data sources.

## Tools

| Tool | Description |
|------|-------------|

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "h1b": {
      "url": "https://gateway.pipeworx.io/h1b/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1339+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about H1b data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
