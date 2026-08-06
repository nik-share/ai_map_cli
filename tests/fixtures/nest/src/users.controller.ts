// @ts-nocheck
import {
  Body,
  Controller as RouteController,
  Get as Read,
  Param,
  Post as Create,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import { CreateUserDto } from "./create-user.dto";
import { UsersService } from "./users.service";

@RouteController("users")
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Read(":id")
  getById(@Param("id") id: string) {
    return this.users.findOne(id);
  }

  @Create()
  create(@Body() input: CreateUserDto) {
    return this.users.create(input);
  }
}
