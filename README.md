# mcp-h1b

H-1B MCP — US H-1B visa sponsorship & wage data from DOL Labor Condition

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `h1b_employer_sponsorship` | Check whether a US employer sponsors H-1B visas and profile their sponsorship, from DOL Labor Condition Application (LCA) disclosures. Answers 'does company X sponsor H-1B / green cards' for recruiting and candidate advising. Returns the number of certified LCA filings, base-salary range (min / median / max), the top sponsored job titles, and top work locations for the employer. Filter by year (defaults to the latest full year). Employer name is matched as the disclosed legal name (e.g. 'Google', 'Amazon.com Services'). |
| `h1b_salary` | Look up real H-1B base salaries for a job title from DOL LCA disclosures — a market wage benchmark backed by actual filed salaries (not estimates). Answers 'what do H-1B software engineers earn at company X / in city Y'. Filter by job title, and optionally by employer, city, and year. Returns salary statistics (count, min / median / average / max) plus a sample of individual records (employer, title, salary, location, dates). |
| `h1b_top_sponsors` | Find which US employers sponsor the most H-1B visas for a given job title (optionally in a specific city) — a candidate-sourcing / target-account signal for recruiting. Answers 'which companies sponsor the most data engineers in Austin' or 'top H-1B sponsors for nurses'. Returns employers ranked by certified LCA filings for the role, each with their filing count and median base salary. Backed by real DOL LCA disclosures. |

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

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

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
