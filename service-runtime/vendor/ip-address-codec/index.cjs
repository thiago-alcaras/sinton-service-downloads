// The tracker server needs only binary-address formatting. Deliberately omit
// node-ip's vulnerable public/private classification API; Sinton uses node:net.
exports.toString = function toString(value, offset = 0, length) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
    const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); value = bytes;
  }
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected IP address bytes');
  length ??= value.length - offset;
  if (!Number.isInteger(offset) || offset < 0 || offset + length > value.length) throw new RangeError('Invalid IP address range');
  const bytes = value.subarray(offset, offset + length);
  if (length === 4) return Array.from(bytes).join('.');
  if (length === 16) return Array.from({length:8},(_,index)=>((bytes[index*2]<<8)|bytes[index*2+1]).toString(16)).join(':');
  throw new RangeError('Expected an IPv4 or IPv6 address');
};
