import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { decisionSessions, projects } from "../schema";

type ProjectInput = {
  name: string;
  summary: string;
  targetUsers: string;
  businessModel: string;
  expectedData: string;
};

type SessionInput = {
  id: string;
  projectId: string;
  locale: string;
  phase: string;
  operationalStatus: string;
  currentConclusion: string | null;
};

export class DecisionSessionRepository {
  constructor(private readonly database: Database) {}

  async createWithProject(project: ProjectInput, session: SessionInput) {
    return this.database.transaction(async (transaction) => {
      await transaction.insert(projects).values({
        id: session.projectId,
        name: project.name,
        input: project,
        locale: session.locale
      });
      const [created] = await transaction
        .insert(decisionSessions)
        .values(session)
        .returning();
      return created ?? null;
    });
  }

  async create(input: SessionInput) {
    const [created] = await this.database
      .insert(decisionSessions)
      .values(input)
      .returning();
    return created ?? null;
  }

  async getById(id: string) {
    const [session] = await this.database
      .select()
      .from(decisionSessions)
      .where(eq(decisionSessions.id, id))
      .limit(1);
    return session ?? null;
  }
}
