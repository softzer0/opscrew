import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  async index(): Promise<{ visits: number }> {
    return { visits: await this.appService.recordVisit() };
  }

  @Get("health")
  health(): { status: string } {
    return { status: "ok" };
  }
}
