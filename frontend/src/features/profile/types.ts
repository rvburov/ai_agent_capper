import type { components } from '../../api/schema';

export type Session = components['schemas']['SessionOut'];
export type TrustedDevice = components['schemas']['TrustedDeviceOut'];
export type LoginEvent = components['schemas']['LoginEventOut'];
export type LoginResult = LoginEvent['result'];
export type RecoveryCodesStatus = components['schemas']['RecoveryCodesStatusOut'];
export type PublicSettings = components['schemas']['PublicSettingsOut'];
export type ProfileUpdate = components['schemas']['ProfileUpdateIn'];
