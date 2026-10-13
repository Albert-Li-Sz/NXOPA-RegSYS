import { describe, it, expect } from 'vitest';
import { profileComplete, userTagsSchema } from '../../packages/contracts/src/index.js';

const complete = {
  name: '林同学',
  profile: {
    student_id: '20260001',
    class_name: '计算机一班',
    college: '信息工程学院',
    gender: '女',
  },
};
describe('student profile and administrator tags', () => {
  it('requires all five fields and rejects whitespace-only answers', () => {
    expect(profileComplete(complete)).toBe(true);
    expect(profileComplete({ ...complete, name: '  ' })).toBe(false);
    for (const key of ['student_id', 'class_name', 'college', 'gender']) {
      expect(profileComplete({ ...complete, profile: { ...complete.profile, [key]: '' } })).toBe(
        false,
      );
      expect(profileComplete({ ...complete, profile: { ...complete.profile, [key]: '   ' } })).toBe(
        false,
      );
    }
    expect(profileComplete({ ...complete, profile: null })).toBe(false);
  });
  it('normalizes duplicate tags while rejecting empty and oversized values', () => {
    expect(userTagsSchema.parse(['集训队', ' 集训队 ', '2026级'])).toEqual(['集训队', '2026级']);
    expect(() => userTagsSchema.parse([' '])).toThrow();
    expect(() => userTagsSchema.parse(['x'.repeat(41)])).toThrow();
    expect(() => userTagsSchema.parse(Array.from({ length: 21 }, (_, i) => `标签${i}`))).toThrow();
  });
});
