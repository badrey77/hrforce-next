import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { EmployeeRepository } from '../infra/employee.repository.js';
export type Db = Kysely<unknown>;
export const bad = [Injectable, EmployeeRepository];
