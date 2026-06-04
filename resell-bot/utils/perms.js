const config = require('./../config.json');

function hasRole(member, roleId) {
  return !!roleId && member.roles.cache.has(roleId);
}

// Admin = Discord Administrator perm OR the configured admin role
function isAdmin(member) {
  return member.permissions.has('Administrator') || hasRole(member, config.adminRoleId);
}

// Mod = everything an admin is, plus the mod role
function isMod(member) {
  return isAdmin(member) || hasRole(member, config.modRoleId);
}

// Staff = everything a mod is, plus the support/staff role
function isStaff(member) {
  return isMod(member) || hasRole(member, config.staffRoleId);
}

module.exports = { isAdmin, isMod, isStaff, hasRole };
