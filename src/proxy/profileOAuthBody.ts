import { z } from "zod"

export const profileStartBody = z.object({ profile: z.string().optional() })
export const profileLoginCompleteBody = z.object({ loginId: z.string().optional(), code: z.string().optional() })
export const profileAddCompleteBody = z.object({ addId: z.string().optional(), code: z.string().optional() })
