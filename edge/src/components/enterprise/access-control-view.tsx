'use client';

import { useState } from 'react';
import { RBACManager } from '../rbac/rbac-manager';
import { MOCK_PERMISSIONS, MOCK_ROLES, MOCK_USERS, type RbacUser, type Role } from './mock-data';

export function AccessControlView() {
  const [roles, setRoles] = useState<Role[]>(MOCK_ROLES);
  const [users, setUsers] = useState<RbacUser[]>(MOCK_USERS);

  const updateUserRoles = (userId: string, roleId: string) => {
    setUsers((prev) => prev.map((user) => (user.id === userId ? { ...user, roleId } : user)));
  };

  const updateRolePermissions = (roleId: string, permissions: string[]) => {
    setRoles((prev) =>
      prev.map((role) => (role.id === roleId ? { ...role, permissions } : role)),
    );
  };

  return (
    <RBACManager
      roles={roles}
      users={users}
      permissions={MOCK_PERMISSIONS}
      onUpdateUserRoles={updateUserRoles}
      onUpdateRolePermissions={updateRolePermissions}
    />
  );
}
