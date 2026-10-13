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
  it('validates real calendar dates in teacher identity information', () => {
    const teacher = {
      name: '教师测试',
      kind: 'TEACHER',
      profile: {
        employee_id: 'T-001',
        employed_at: '2024-02-29',
        college: '测试院系',
        gender: '男',
      },
    };
    expect(profileComplete(teacher)).toBe(true);
    for (const employed_at of ['2026-02-31', '2025-02-29', '2026-13-01', '2026-01-00'])
      expect(profileComplete({ ...teacher, profile: { ...teacher.profile, employed_at } })).toBe(
        false,
      );
  });
});
