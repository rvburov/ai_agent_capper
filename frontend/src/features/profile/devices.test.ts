import { describe, expect, it } from 'vitest';

import { deviceIcon, deviceName, lowerFirst, maskIp } from './devices';

describe('устройства', () => {
  it('иконка: телефон или компьютер', () => {
    expect(deviceIcon('Safari · iOS')).toBe('device');
    expect(deviceIcon('Chrome · Android')).toBe('device');
    expect(deviceIcon('Chrome · Windows')).toBe('laptop');
    expect(deviceIcon('')).toBe('laptop');
  });

  it('пустая метка — «Неизвестное устройство»', () => {
    expect(deviceName('', 'Неизвестное устройство')).toBe('Неизвестное устройство');
    expect(deviceName('  ', 'Неизвестное устройство')).toBe('Неизвестное устройство');
    expect(deviceName('Firefox · Linux', '?')).toBe('Firefox · Linux');
  });

  it('IP показывается частично', () => {
    expect(maskIp('88.193.12.4')).toBe('88.193.xx.xx');
    expect(maskIp('2a01:4f9:c010:1234::1')).toBe('2a01:4f9:…');
    expect(maskIp(null)).toBe('—');
  });

  it('время внутри фразы — со строчной буквы', () => {
    expect(lowerFirst('Сегодня, 19:54')).toBe('сегодня, 19:54');
    expect(lowerFirst('8 окт, 10:00')).toBe('8 окт, 10:00');
  });
});
