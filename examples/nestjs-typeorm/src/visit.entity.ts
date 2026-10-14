import { CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("visits")
export class Visit {
  @PrimaryGeneratedColumn()
  id!: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
