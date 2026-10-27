'use client';

import { useState } from 'react';
import { t } from '../../i18n/locale';

interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'rejected';
  assignee?: string;
  dueDate?: string;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  steps: WorkflowStep[];
  createdBy: string;
  createdAt: string;
}

interface WorkflowManagerProps {
  workflows: Workflow[];
  currentUser: string;
  onApproveStep: (workflowId: string, stepId: string) => void;
  onRejectStep: (workflowId: string, stepId: string, reason: string) => void;
  onCompleteWorkflow: (workflowId: string) => void;
}

export function WorkflowManager({ 
  workflows, 
  currentUser,
  onApproveStep,
  onRejectStep,
  onCompleteWorkflow
}: WorkflowManagerProps) {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [showRejectionModal, setShowRejectionModal] = useState(false);
  const [pendingStepId, setPendingStepId] = useState<string | null>(null);

  const selectedWorkflow = workflows.find(w => w.id === selectedWorkflowId);

  const handleApproveStep = (workflowId: string, stepId: string) => {
    onApproveStep(workflowId, stepId);
  };

  const handleRejectClick = (stepId: string) => {
    setPendingStepId(stepId);
    setShowRejectionModal(true);
  };

  const handleRejectStep = () => {
    if (selectedWorkflowId && pendingStepId && rejectionReason.trim()) {
      onRejectStep(selectedWorkflowId, pendingStepId, rejectionReason);
      setRejectionReason('');
      setShowRejectionModal(false);
      setPendingStepId(null);
    }
  };

  const handleCompleteWorkflow = (workflowId: string) => {
    onCompleteWorkflow(workflowId);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'status-completed';
      case 'in-progress': return 'status-in-progress';
      case 'rejected': return 'status-rejected';
      default: return 'status-pending';
    }
  };

  return (
    <div className="workflow-manager">
      <div className="workflow-header">
        <h2>{t('workflow.workflowManagement')}</h2>
        <p>{t('workflow.manageApprovalWorkflows')}</p>
      </div>

      <div className="workflow-content">
        {/* Workflow List */}
        <div className="workflow-list-section">
          <h3>{t('workflow.workflows')}</h3>
          <table className="workflow-table">
            <thead>
              <tr>
                <th scope="col">{t('workflow.workflows')}</th>
                <th scope="col">{t('filter.status')}</th>
                <th scope="col">{t('workflow.progress')}</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map(workflow => {
                const completed = workflow.steps.filter(s => s.status === 'completed').length;
                const total = workflow.steps.length;
                return (
                  <tr
                    key={workflow.id}
                    className={selectedWorkflowId === workflow.id ? 'selected' : undefined}
                    onClick={() => setSelectedWorkflowId(workflow.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedWorkflowId(workflow.id);
                      }
                    }}
                    tabIndex={0}
                  >
                    <th scope="row">{workflow.name}</th>
                    <td>
                      <span className={`workflow-status ${getStatusColor(workflow.status)}`}>
                        {t(`workflow.status.${workflow.status}`)}
                      </span>
                    </td>
                    <td>
                      <div className="workflow-progress">
                        <div className="progress-bar">
                          <div
                            className="progress-fill"
                            style={{ width: `${total === 0 ? 0 : (completed / total) * 100}%` }}
                          />
                        </div>
                        <span>
                          {t('workflow.progress')}: {completed}/{total}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Workflow Detail */}
        <div className="workflow-detail-section">
          {selectedWorkflow ? (
            <div className="workflow-detail">
              <div className="workflow-detail-header">
                <h3>{selectedWorkflow.name}</h3>
                <span className={`workflow-status ${getStatusColor(selectedWorkflow.status)}`}>
                  {t(`workflow.status.${selectedWorkflow.status}`)}
                </span>
              </div>
              <p className="workflow-detail-description">{selectedWorkflow.description}</p>
              <dl className="workflow-detail-meta">
                <div>
                  <dt>{t('workflow.createdBy')}</dt>
                  <dd>{selectedWorkflow.createdBy}</dd>
                </div>
                <div>
                  <dt>{t('workflow.createdAt')}</dt>
                  <dd>{new Date(selectedWorkflow.createdAt).toLocaleDateString()}</dd>
                </div>
              </dl>
              
              <div className="workflow-steps">
                <h4>{t('workflow.steps')}</h4>
                <div className="steps-list">
                  {selectedWorkflow.steps.map((step, index) => (
                    <div key={step.id} className="step-item">
                      <div className="step-header">
                        <div className="step-number">{index + 1}</div>
                        <div className="step-info">
                          <h5>{step.name}</h5>
                          <p>{step.description}</p>
                        </div>
                        <span className={`step-status ${getStatusColor(step.status)}`}>
                          {t(`workflow.stepStatus.${step.status}`)}
                        </span>
                      </div>
                      
                      {step.assignee && (
                        <div className="step-assignee">
                          <span>{t('workflow.assignedTo')}: {step.assignee}</span>
                          {step.dueDate && (
                            <span>{t('workflow.dueDate')}: {new Date(step.dueDate).toLocaleDateString()}</span>
                          )}
                        </div>
                      )}
                      
                      {step.status === 'pending' && step.assignee === currentUser && (
                        <div className="step-actions">
                          <button 
                            className="primary-action"
                            onClick={() => handleApproveStep(selectedWorkflow.id, step.id)}
                          >
                            {t('workflow.approve')}
                          </button>
                          <button 
                            className="secondary-action"
                            onClick={() => handleRejectClick(step.id)}
                          >
                            {t('workflow.reject')}
                          </button>
                        </div>
                      )}
                      
                      {step.status === 'rejected' && (
                        <div className="rejection-note">
                          <strong>{t('workflow.rejected')}:</strong> {step.description}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              
              {selectedWorkflow.steps.every(s => s.status === 'completed') && selectedWorkflow.status !== 'completed' && (
                <div className="workflow-actions">
                  <button 
                    className="primary-action"
                    onClick={() => handleCompleteWorkflow(selectedWorkflow.id)}
                  >
                    {t('workflow.completeWorkflow')}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="workflow-detail-placeholder">
              <p>{t('workflow.selectWorkflowToViewDetails')}</p>
            </div>
          )}
        </div>
      </div>

      {/* Rejection Modal */}
      {showRejectionModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h3>{t('workflow.rejectStep')}</h3>
            </div>
            <div className="modal-body">
              <textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder={t('workflow.enterRejectionReason')}
                rows={4}
              />
            </div>
            <div className="modal-footer">
              <button 
                className="secondary-action"
                onClick={() => setShowRejectionModal(false)}
              >
                {t('workflow.cancel')}
              </button>
              <button 
                className="primary-action"
                onClick={handleRejectStep}
                disabled={!rejectionReason.trim()}
              >
                {t('workflow.reject')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}