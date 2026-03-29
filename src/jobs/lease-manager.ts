import { TranslationJobsRepository } from "../db/repositories/translation-jobs-repository";

export class LeaseManager {
  constructor(private readonly jobsRepository: TranslationJobsRepository) {}

  recoverExpiredJobs(): number {
    return this.jobsRepository.resetExpiredInProgressJobs();
  }
}
