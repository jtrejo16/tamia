import type * as s from "./schema";

export type Tenant = typeof s.tenants.$inferSelect;
export type AgentConfig = typeof s.agentConfigs.$inferSelect;
export type Contact = typeof s.contacts.$inferSelect;
export type Conversation = typeof s.conversations.$inferSelect;
export type Message = typeof s.messages.$inferSelect;
export type Service = typeof s.services.$inferSelect;
export type Staff = typeof s.staff.$inferSelect;
export type Appointment = typeof s.appointments.$inferSelect;
