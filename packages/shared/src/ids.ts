import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

export const newId = (): string => uuidv7();
export const IdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });
