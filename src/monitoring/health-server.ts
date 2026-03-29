import http from "node:http";
import { Logger } from "pino";
import { StatusService } from "./status-service";

export class HealthServer {
  private server: http.Server | null = null;

  constructor(
    private readonly port: number,
    private readonly statusService: StatusService,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.server) {
      return;
    }

    this.server = http.createServer((request, response) => {
      const report = this.statusService.buildReport();
      if (request.url === "/health/live") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.url === "/health/ready") {
        response.writeHead(this.statusService.isReady() ? 200 : 503, { "Content-Type": "application/json" });
        response.end(JSON.stringify(report));
        return;
      }

      if (request.url === "/health/report") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(report));
        return;
      }

      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
    });

    this.server.listen(this.port, () => {
      this.logger.info({ event: "health_server_started", port: this.port }, "Health server started");
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
