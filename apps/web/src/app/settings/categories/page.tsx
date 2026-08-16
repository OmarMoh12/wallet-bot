'use client';

import { useState } from 'react';
import type { CategoryDto, CategoryKind } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { Sheet } from '@/components/ui/Sheet';
import {
  Badge,
  Button,
  Card,
  Divider,
  Field,
  Input,
  Segmented,
  SkeletonList,
} from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { api } from '@/lib/api';
import { useApiQuery, useMutation } from '@/hooks/useApi';
import { useApp } from '@/providers/AppProvider';

export default function CategoriesPage() {
  const { t } = useApp();
  const { data, loading, refetch } = useApiQuery<{ items: CategoryDto[] }>('/api/categories');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CategoryKind>('expense');

  const create = useMutation(
    (input: Record<string, unknown>) => api.post<CategoryDto>('/api/categories', input),
    {
      onSuccess: () => {
        setName('');
        setAdding(false);
        void refetch();
      },
    },
  );

  const remove = useMutation((id: string) => api.delete(`/api/categories/${id}`), {
    onSuccess: () => void refetch(),
  });

  return (
    <Screen
      title={t('categories.title')}
      back
      action={
        <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
          {t('categories.add')}
        </Button>
      }
    >
      {loading ? (
        <SkeletonList rows={4} />
      ) : (
        <Card>
          {(data?.items ?? []).map((category, index) => (
            <div key={category.id}>
              {index > 0 ? <Divider /> : null}
              <div className="flex items-center gap-3 px-4 py-3">
                <span
                  className="h-8 w-8 shrink-0 rounded-full"
                  style={{ background: category.color ?? 'var(--color-surface-raised)' }}
                  aria-hidden="true"
                />
                <span className="flex-1 truncate text-[15px] text-text">{category.name}</span>
                {category.isSystem ? (
                  <Badge>{t('categories.system')}</Badge>
                ) : (
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={() => void remove.mutate(category.id)}
                    className="text-negative"
                  >
                    <Icon name="trash" size={17} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title={t('categories.add')}
        footer={
          <Button
            fullWidth
            size="lg"
            loading={create.pending}
            disabled={name.trim().length === 0}
            onClick={() => void create.mutate({ name: name.trim(), kind })}
          >
            {t('common.save')}
          </Button>
        }
      >
        <div className="space-y-4 pb-2">
          <Field label={t('categories.name')} htmlFor="category-name" required>
            <Input
              id="category-name"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('categories.kind')}>
            <Segmented
              ariaLabel={t('categories.kind')}
              value={kind}
              onChange={setKind}
              options={[
                { value: 'expense', label: t('tx.filter.expense') },
                { value: 'income', label: t('tx.filter.income') },
                { value: 'both', label: t('common.all') },
              ]}
            />
          </Field>
        </div>
      </Sheet>
    </Screen>
  );
}
