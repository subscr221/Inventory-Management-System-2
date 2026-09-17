'use client';

import { useState } from 'react';
import { WorkflowManager } from '../workflow/workflow-manager';
import { MOCK_WORKFLOWS, type Workflow } from './mock-data';

export function WorkflowsView({ currentUserName }: { currentUserName: string }) {
  const [workflows, setWorkflows] = useState<Workflow[]>(MOCK_WORKFLOWS);

  const approveStep = (workflowId: string, stepId: string) => {
    setWorkflows((prev) =>
      prev.map((workflow) =>
        workflow.id === workflowId
          ? {
              ...workflow,
              steps: workflow.steps.map((step) =>
                step.id === stepId ? { ...step, status: 'completed' as const } : step,
              ),
            }
          : workflow,
      ),
    );
  };

  const rejectStep = (workflowId: string, stepId: string, reason: string) => {
    setWorkflows((prev) =>
      prev.map((workflow) =>
        workflow.id === workflowId
          ? {
              ...workflow,
              steps: workflow.steps.map((step) =>
                step.id === stepId ? { ...step, status: 'rejected' as const, description: reason } : step,
              ),
            }
          : workflow,
      ),
    );
  };

  const completeWorkflow = (workflowId: string) => {
    setWorkflows((prev) =>
      prev.map((workflow) =>
        workflow.id === workflowId ? { ...workflow, status: 'completed' as const } : workflow,
      ),
    );
  };

  return (
    <WorkflowManager
      workflows={workflows}
      currentUser={currentUserName}
      onApproveStep={approveStep}
      onRejectStep={rejectStep}
      onCompleteWorkflow={completeWorkflow}
    />
  );
}
