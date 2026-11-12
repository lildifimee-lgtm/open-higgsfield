# ChatGPT MCP integration

This repository includes a stateless MCP Streamable HTTP endpoint at `/api/mcp`.
It exposes the existing OpenHiggsfield model catalog and generation pipeline to
MCP clients without changing the browser studio.

## Deploy

Deploy this Next.js app to a public HTTPS host (Vercel is supported), then set
these server-side environment variables in the hosting dashboard:

- `HF_API_BASE_URL`: generation platform API origin.
- `HF_PLATFORM_API_KEY`: your platform credential in `id:secret` format.
- `MCP_ACCESS_TOKEN`: a long, random secret used to protect the MCP endpoint.

Do not commit these values or paste them into source files. Redeploy after
setting them. The existing `OPEN_HIGGSFIELD_READ_WRITE_TOKEN` remains needed
only if you use the studio's Vercel Blob uploads.

## Connect ChatGPT

In ChatGPT, add a custom app/connector using the deployed URL
`https://YOUR-DOMAIN/api/mcp`. Choose the MCP/Streamable HTTP transport and
configure bearer-token authentication with the value of `MCP_ACCESS_TOKEN`.
The exact UI labels depend on the ChatGPT client and workspace.

Available tools:

- `openhiggsfield_list_models`
- `openhiggsfield_generate`
- `openhiggsfield_check_status`

Generation is asynchronous: submit a job, then poll its request ID until it
returns image or video URLs. The model's declared settings are validated by
the same catalog used by the studio.

## Important

Connecting the GitHub app to ChatGPT only grants repository access; it does not
run the generation service. This MCP endpoint must be deployed to a public
HTTPS URL and its environment variables must be configured before ChatGPT can
call it. The platform API key and MCP access token stay on the server.
