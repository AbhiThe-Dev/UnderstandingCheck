export type ApplicationStatus = 'draft' | 'submitted' | 'pending' | 'approved' | 'rejected';

export interface Application {
  id: string;
  applicantId: string;
  applicantEmail: string;
  status: ApplicationStatus;
  approvedAt?: Date;
  approvedBy?: string;
  rejectionReason?: string;
}

export interface Reviewer {
  id: string;
  name: string;
  isAdmin: boolean;
}
