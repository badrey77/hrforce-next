import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type {
  ChildValues,
  ContactValues,
  EmergencyValues,
  FamilyValues,
  MaritalStatus,
  Relationship,
  SpouseEmployed,
} from '../domain/personal.js';

export interface ContactRow extends ContactValues {
  updatedAt: string;
}

export interface ChildRow extends ChildValues {
  id: string;
}

/** Personal-details tables of migration 0025 (person_contact, person_emergency_contact, person_family, person_child). */
@Injectable()
export class PersonalRepository {
  async findContact(companyId: string, personId: string): Promise<ContactRow | undefined> {
    const row = await currentTx()
      .selectFrom('person_contact')
      .select([
        'mobile_phone as mobilePhone',
        'other_phone as otherPhone',
        'personal_email as personalEmail',
        'address_line as addressLine',
        'commune',
        'wilaya_code as wilayaCode',
        'postal_code as postalCode',
        'updated_at as updatedAt',
      ])
      .where('company_id', '=', companyId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
    return row ? { ...row, updatedAt: row.updatedAt.toISOString() } : undefined;
  }

  async findEmergency(companyId: string, personId: string): Promise<EmergencyValues | undefined> {
    const row = await currentTx()
      .selectFrom('person_emergency_contact')
      .select(['full_name as fullName', 'relationship', 'phone'])
      .where('company_id', '=', companyId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
    return row ? { ...row, relationship: row.relationship as Relationship } : undefined;
  }

  async findFamily(companyId: string, personId: string): Promise<FamilyValues | undefined> {
    const row = await currentTx()
      .selectFrom('person_family')
      .select(['marital_status as maritalStatus', sql<string | null>`marital_status_since::text`.as('maritalStatusSince'), 'spouse_employed as spouseEmployed'])
      .where('company_id', '=', companyId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
    return row
      ? { maritalStatus: row.maritalStatus as MaritalStatus | null, maritalStatusSince: row.maritalStatusSince, spouseEmployed: row.spouseEmployed as SpouseEmployed | null }
      : undefined;
  }

  /** Oldest first (birth date, then recording order). */
  async listChildren(companyId: string, personId: string): Promise<ChildRow[]> {
    const rows = await currentTx()
      .selectFrom('person_child')
      .select(['id', 'first_name as firstName', sql<string>`birth_date::text`.as('birthDate'), 'sex', 'dependent'])
      .where('company_id', '=', companyId)
      .where('person_id', '=', personId)
      .orderBy('birth_date')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ ...r, sex: r.sex === 'M' || r.sex === 'F' ? r.sex : null }));
  }

  /** Locks the person's row: concurrent writes of the same person's details run one after the other. */
  async lockPerson(companyId: string, personId: string): Promise<void> {
    await currentTx().selectFrom('person').select('id').where('company_id', '=', companyId).where('id', '=', personId).forUpdate().execute();
  }

  async upsertContact(companyId: string, personId: string, values: ContactValues, actorId: string | null): Promise<void> {
    const columns = {
      mobile_phone: values.mobilePhone,
      other_phone: values.otherPhone,
      personal_email: values.personalEmail,
      address_line: values.addressLine,
      commune: values.commune,
      wilaya_code: values.wilayaCode,
      postal_code: values.postalCode,
      updated_by: actorId,
    };
    await currentTx()
      .insertInto('person_contact')
      .values({ company_id: companyId, person_id: personId, ...columns })
      .onConflict((oc) => oc.column('person_id').doUpdateSet({ ...columns, updated_at: sql<Date>`now()` }))
      .execute();
  }

  async upsertEmergency(companyId: string, personId: string, values: EmergencyValues, actorId: string | null): Promise<void> {
    const columns = { full_name: values.fullName, relationship: values.relationship, phone: values.phone, updated_by: actorId };
    await currentTx()
      .insertInto('person_emergency_contact')
      .values({ company_id: companyId, person_id: personId, ...columns })
      .onConflict((oc) => oc.column('person_id').doUpdateSet({ ...columns, updated_at: sql<Date>`now()` }))
      .execute();
  }

  async deleteEmergency(companyId: string, personId: string): Promise<void> {
    await currentTx().deleteFrom('person_emergency_contact').where('company_id', '=', companyId).where('person_id', '=', personId).execute();
  }

  async upsertFamily(companyId: string, personId: string, values: FamilyValues, actorId: string | null): Promise<void> {
    const columns = {
      marital_status: values.maritalStatus,
      marital_status_since: values.maritalStatusSince,
      spouse_employed: values.spouseEmployed,
      updated_by: actorId,
    };
    await currentTx()
      .insertInto('person_family')
      .values({ company_id: companyId, person_id: personId, ...columns })
      .onConflict((oc) => oc.column('person_id').doUpdateSet({ ...columns, updated_at: sql<Date>`now()` }))
      .execute();
  }

  async insertChild(companyId: string, personId: string, child: ChildValues): Promise<void> {
    await currentTx()
      .insertInto('person_child')
      .values({ company_id: companyId, person_id: personId, first_name: child.firstName, birth_date: child.birthDate, sex: child.sex, dependent: child.dependent })
      .execute();
  }

  async updateChild(companyId: string, personId: string, child: ChildValues & { id: string }): Promise<void> {
    await currentTx()
      .updateTable('person_child')
      .set({ first_name: child.firstName, birth_date: child.birthDate, sex: child.sex, dependent: child.dependent, updated_at: sql<Date>`now()` })
      .where('company_id', '=', companyId)
      .where('person_id', '=', personId)
      .where('id', '=', child.id)
      .execute();
  }

  async deleteChildren(companyId: string, personId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await currentTx().deleteFrom('person_child').where('company_id', '=', companyId).where('person_id', '=', personId).where('id', 'in', ids).execute();
  }
}
