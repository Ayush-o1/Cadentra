import type { Db } from '../../lib/db.js';
import { isUniqueViolation } from '../../lib/db.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { recordActivity } from '../activity/activity.service.js';

export type ListView = { id: number; name: string; contactCount: number; createdAt: Date };

const duplicateName = () => conflict('A list with this name already exists', 'LIST_EXISTS');

export function createListsService(db: Db) {
  async function view(workspaceId: number, id: number): Promise<ListView> {
    const list = await db.contactList.findFirst({
      where: { id, workspaceId },
      include: { _count: { select: { members: true } } },
    });
    if (!list) throw notFound('List');
    return {
      id: list.id,
      name: list.name,
      contactCount: list._count.members,
      createdAt: list.createdAt,
    };
  }

  return {
    view,

    async list(workspaceId: number): Promise<ListView[]> {
      const lists = await db.contactList.findMany({
        where: { workspaceId },
        include: { _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
      });
      return lists.map((list) => ({
        id: list.id,
        name: list.name,
        contactCount: list._count.members,
        createdAt: list.createdAt,
      }));
    },

    async create(workspaceId: number, userId: number, name: string): Promise<ListView> {
      try {
        const list = await db.contactList.create({ data: { workspaceId, name } });
        await recordActivity(db, {
          workspaceId,
          userId,
          action: 'list.created',
          entityType: 'list',
          entityId: list.id,
        });
        return view(workspaceId, list.id);
      } catch (error) {
        if (isUniqueViolation(error)) throw duplicateName();
        throw error;
      }
    },

    async rename(workspaceId: number, id: number, name: string): Promise<ListView> {
      try {
        const { count } = await db.contactList.updateMany({
          where: { id, workspaceId },
          data: { name },
        });
        if (count === 0) throw notFound('List');
      } catch (error) {
        if (isUniqueViolation(error)) throw duplicateName();
        throw error;
      }
      return view(workspaceId, id);
    },

    async remove(workspaceId: number, userId: number, id: number): Promise<void> {
      const list = await db.contactList.findFirst({ where: { id, workspaceId } });
      if (!list) throw notFound('List');
      const campaigns = await db.campaign.count({ where: { workspaceId, listId: id } });
      if (campaigns > 0) {
        throw conflict(
          'This list is used by a campaign. Delete or change the campaign first.',
          'LIST_IN_USE',
        );
      }
      await db.contactList.delete({ where: { id } });
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'list.deleted',
        entityType: 'list',
        entityId: id,
        metadata: { name: list.name },
      });
    },

    async addMembers(workspaceId: number, listId: number, contactIds: number[]) {
      await view(workspaceId, listId);
      const unique = [...new Set(contactIds)];
      const owned = await db.contact.count({ where: { workspaceId, id: { in: unique } } });
      if (owned !== unique.length) {
        throw validationFailed('One of the selected contacts does not exist', [
          { path: 'contactIds', message: 'One of the selected contacts does not exist' },
        ]);
      }
      const result = await db.contactListMember.createMany({
        data: unique.map((contactId) => ({ workspaceId, listId, contactId })),
        skipDuplicates: true,
      });
      return { added: result.count };
    },

    async removeMember(workspaceId: number, listId: number, contactId: number): Promise<void> {
      const { count } = await db.contactListMember.deleteMany({
        where: { workspaceId, listId, contactId },
      });
      if (count === 0) throw notFound('List member');
    },
  };
}
