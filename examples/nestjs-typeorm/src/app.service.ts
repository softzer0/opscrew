import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Visit } from "./visit.entity";

@Injectable()
export class AppService {
  private ready?: Promise<DataSource>;

  constructor(private readonly dataSource: DataSource) {}

  /** Records a visit in Postgres and returns the total. */
  async recordVisit(): Promise<number> {
    const visits = (await this.connection()).getRepository(Visit);
    await visits.insert({});
    return visits.count();
  }

  private connection(): Promise<DataSource> {
    this.ready ??= this.dataSource.initialize().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }
}
