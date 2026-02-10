import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import open from "open";
import getPort from "get-port";

export interface OAuthCallbackResult {
  code?: string;
  error?: string;
  errorDescription?: string;
}

const OAUTH_TIMEOUT_MS = 120_000; // 2 minutes

export async function captureOAuthCallback(
  authUrl: string,
  preferredPort: number = 8888
): Promise<OAuthCallbackResult> {
  const port = await getPort({ port: preferredPort });

  return new Promise((resolve, reject) => {
    let isResolved = false;
    let server: Server;

    const cleanup = () => {
      if (!isResolved) {
        isResolved = true;
        server?.close();
      }
    };

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

        if (code) {
          res.end(generateSuccessHTML());
          cleanup();
          resolve({ code });
        } else {
          res.end(generateErrorHTML(error, errorDescription));
          cleanup();
          resolve({
            error: error || "unknown_error",
            errorDescription: errorDescription || undefined,
          });
        }
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth timeout - authorization not completed within 2 minutes"));
    }, OAUTH_TIMEOUT_MS);

    server.on("close", () => {
      clearTimeout(timer);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`OAuth server error: ${err.message}`));
    });

    server.listen(port, "127.0.0.1", async () => {
      const actualAuthUrl = authUrl.replace(
        /redirect_uri=[^&]+/,
        `redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`
      );

      console.log(`OAuth callback server listening on http://localhost:${port}/callback`);

      try {
        await open(actualAuthUrl);
        console.log("Browser opened. Waiting for authorization...");
      } catch {
        console.log("\nCould not open browser automatically.");
        console.log("Please open this URL manually:\n");
        console.log(actualAuthUrl);
        console.log("");
      }
    });
  });
}

function generateSuccessHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorization Successful</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container { text-align: center; padding: 2rem; max-width: 400px; }
    .checkmark {
      width: 80px; height: 80px; border-radius: 50%;
      background: rgba(255,255,255,0.2);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.5rem; font-size: 3rem;
    }
    h1 { font-size: 1.75rem; margin-bottom: 0.75rem; }
    p { font-size: 1.1rem; opacity: 0.9; line-height: 1.5; }
    .hint { margin-top: 1.5rem; font-size: 0.9rem; opacity: 0.7; }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">&#10003;</div>
    <h1>Authorization Successful!</h1>
    <p>Your Strava account has been connected to RunnAI.</p>
    <p class="hint">You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`;
}

function generateErrorHTML(error?: string | null, description?: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorization Failed</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
      color: white;
    }
    .container { text-align: center; padding: 2rem; max-width: 400px; }
    .error-icon {
      width: 80px; height: 80px; border-radius: 50%;
      background: rgba(255,255,255,0.2);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.5rem; font-size: 3rem;
    }
    h1 { font-size: 1.75rem; margin-bottom: 0.75rem; }
    p { font-size: 1.1rem; opacity: 0.9; line-height: 1.5; }
    .error-details {
      background: rgba(0,0,0,0.2); padding: 1rem;
      border-radius: 8px; margin-top: 1rem; font-size: 0.9rem; text-align: left;
    }
    .hint { margin-top: 1.5rem; font-size: 0.9rem; opacity: 0.7; }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">&#10007;</div>
    <h1>Authorization Failed</h1>
    <p>Could not connect to your Strava account.</p>
    ${error ? `<div class="error-details"><strong>Error:</strong> ${error}${description ? `<br><strong>Details:</strong> ${description}` : ""}</div>` : ""}
    <p class="hint">Please return to the terminal and try again.</p>
  </div>
</body>
</html>`;
}
