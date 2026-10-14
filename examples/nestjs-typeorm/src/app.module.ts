import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { dataSourceOptions } from "./data-source";

@Module({
  // The data source connects on the first request, so the app starts without the database.
  imports: [TypeOrmModule.forRoot({ ...dataSourceOptions, manualInitialization: true })],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
