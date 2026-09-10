import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

const UUIDv7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const newId = (): string => uuidv7();
export const IdSchema = z.string().regex(UUIDv7Pattern, "Expected a UUIDv7 string");
export const TimestampSchema = z.string().datetime({ offset: true });
