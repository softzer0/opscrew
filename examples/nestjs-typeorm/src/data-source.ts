import { DataSource, DataSourceOptions } from "typeorm";
import { Visit } from "./visit.entity";

/** Shared by the Nest app and the TypeORM CLI (`typeorm migration:run -d dist/data-source.js`). */
export const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [Visit],
  migrations: [`${__dirname}/migrations/*.js`],
};

export default new DataSource(dataSourceOptions);
