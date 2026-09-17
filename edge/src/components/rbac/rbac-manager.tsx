'use client';

import { useState } from 'react';
import { t } from '../../i18n/locale';

interface Permission {
  id: string;
  name: string;
  description: string;
}

interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
}

interface User {
  id: string;
  name: string;
  email: string;
  roleId: string;
}

interface RBACManagerProps {
  roles: Role[];
  users: User[];
  permissions: Permission[];
  onUpdateUserRoles: (userId: string, roleId: string) => void;
  onUpdateRolePermissions: (roleId: string, permissions: string[]) => void;
}

export function RBACManager({ 
  roles, 
  users, 
  permissions,
  onUpdateUserRoles,
  onUpdateRolePermissions
}: RBACManagerProps) {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]>>(() => {
    const initialPermissions: Record<string, string[]> = {};
    roles.forEach(role => {
      initialPermissions[role.id] = [...role.permissions];
    });
    return initialPermissions;
  });

  const selectedRole = roles.find(role => role.id === selectedRoleId);

  const handleRolePermissionChange = (roleId: string, permissionId: string, checked: boolean) => {
    setRolePermissions(prev => {
      const currentPermissions = prev[roleId] || [];
      let newPermissions: string[];
      
      if (checked) {
        newPermissions = [...currentPermissions, permissionId];
      } else {
        newPermissions = currentPermissions.filter(id => id !== permissionId);
      }
      
      return {
        ...prev,
        [roleId]: newPermissions
      };
    });
  };

  const saveRolePermissions = (roleId: string) => {
    const permissions = rolePermissions[roleId] || [];
    onUpdateRolePermissions(roleId, permissions);
  };

  const assignUserRole = (userId: string, roleId: string) => {
    onUpdateUserRoles(userId, roleId);
  };

  return (
    <div className="rbac-manager">
      <div className="rbac-header">
        <h2>{t('rbac.accessControl')}</h2>
        <p>{t('rbac.manageRolesAndPermissions')}</p>
      </div>

      <div className="rbac-content">
        {/* Roles Section */}
        <div className="rbac-section">
          <h3>{t('rbac.roles')}</h3>
          <div className="roles-list">
            {roles.map(role => (
              <div 
                key={role.id} 
                className={`role-item ${selectedRoleId === role.id ? 'selected' : ''}`}
                onClick={() => setSelectedRoleId(role.id)}
              >
                <h4>{role.name}</h4>
                <p>{role.description}</p>
                <span className="permission-count">
                  {t('rbac.permissionsCount').replace('{count}', String(role.permissions.length))}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Users Section */}
        <div className="rbac-section">
          <h3>{t('rbac.users')}</h3>
          <div className="users-list">
            {users.map(user => {
              return (
                <div 
                  key={user.id} 
                  className={`user-item ${selectedUserId === user.id ? 'selected' : ''}`}
                  onClick={() => setSelectedUserId(user.id)}
                >
                  <h4>{user.name}</h4>
                  <p>{user.email}</p>
                  <div className="user-role">
                    <span className="role-label">{t('rbac.role')}:</span>
                    <select 
                      value={user.roleId}
                      onChange={(e) => assignUserRole(user.id, e.target.value)}
                    >
                      {roles.map(role => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Permissions Section */}
        <div className="rbac-section">
          <h3>{t('rbac.permissions')}</h3>
          {selectedRole ? (
            <div className="permissions-manager">
              <div className="permission-header">
                <h4>{selectedRole.name} - {t('rbac.permissions')}</h4>
                <button 
                  className="primary-action"
                  onClick={() => saveRolePermissions(selectedRole.id)}
                >
                  {t('rbac.savePermissions')}
                </button>
              </div>
              <div className="permissions-list">
                {permissions.map(permission => (
                  <div key={permission.id} className="permission-item">
                    <label className="permission-label">
                      <input
                        type="checkbox"
                        checked={rolePermissions[selectedRole.id]?.includes(permission.id) || false}
                        onChange={(e) => handleRolePermissionChange(
                          selectedRole.id, 
                          permission.id, 
                          e.target.checked
                        )}
                      />
                      <span className="permission-info">
                        <span className="permission-name">{permission.name}</span>
                        <span className="permission-description">{permission.description}</span>
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p>{t('rbac.selectRoleToManagePermissions')}</p>
          )}
        </div>
      </div>
    </div>
  );
}