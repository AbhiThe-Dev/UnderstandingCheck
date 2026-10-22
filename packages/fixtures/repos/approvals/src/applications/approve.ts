import { grantAccess } from '../access/permissions';
import { sendApprovalEmail, sendRejectionEmail } from '../notifications/email';
import { findApplication, saveApplication } from './repository';
import type { Application, Reviewer } from './types';

/**
 * Approve a submitted membership application.
 * Approval is the moment an applicant becomes a member: it grants portal access
 * and notifies the applicant.
 */
export async function approveApplication(applicationId: string, reviewer: Reviewer): Promise<Application> {
  const application = await findApplication(applicationId);
  if (application.status !== 'submitted') {
    throw new Error(`Cannot approve an application in status ${application.status}`);
  }

  application.status = 'approved';
  application.approvedAt = new Date();
  application.approvedBy = reviewer.id;
  await saveApplication(application);

  await grantAccess(application.applicantId, 'member-portal');
  await sendApprovalEmail(application.applicantEmail, application.id);
  return application;
}

export async function rejectApplication(applicationId: string, reviewer: Reviewer, reason: string): Promise<Application> {
  const application = await findApplication(applicationId);
  if (application.status !== 'submitted') {
    throw new Error(`Cannot reject an application in status ${application.status}`);
  }
  application.status = 'rejected';
  application.rejectionReason = reason;
  application.approvedBy = reviewer.id;
  await saveApplication(application);
  await sendRejectionEmail(application.applicantEmail, reason);
  return application;
}
