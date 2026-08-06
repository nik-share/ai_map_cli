// @ts-nocheck
import { Injectable } from "@nestjs/common";
import { CreateUserDto } from "./create-user.dto";

@Injectable()
export class UsersService {
  findOne(id: string) {
    return { id };
  }

  create(input: CreateUserDto) {
    return { id: "created", ...input };
  }
}
