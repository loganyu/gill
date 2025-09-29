// TODO: Replace any with inferred types.

"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { Address, Instruction } from "gill";

import { GILL_HOOK_CLIENT_KEY } from "../const.js";

type InstructionBuilder<TInput = any> = (input: TInput, config?: { programAddress?: Address }) => Instruction;

type AccountFetcher<TData = any> = (rpc: any, address: Address, config?: any) => Promise<TData>;

type ProgramHookConfig<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>
> = {
  accounts: TAccounts;
  instructions: TInstructions;
  programAddress?: Address;
};

type UseProgramMutationInput<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any, any>>,
  TInstructionName extends keyof TInstructions,
> = UseMutationOptions<Instruction, Error, Parameters<TInstructions[TInstructionName]>[0]> & {
  instruction: TInstructionName;
  accounts?: {
    [K in keyof TAccounts]?: Parameters<TAccounts[K]>[0];
  } & Record<string, any>; // Allow additional accounts beyond the defined ones
};

type UseProgramQueryInput<
  TAccounts extends Record<string, AccountFetcher<any>>,
  TAccountName extends keyof TAccounts,
> = Omit<UseQueryOptions<Awaited<ReturnType<TAccounts[TAccountName]>>, Error>, "queryKey" | "queryFn"> & {
  account: TAccountName;
  address: Address;
  rpc: Parameters<TAccounts[TAccountName]>[0];
};

export function createProgramHook<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any, any>>,
>(config: ProgramHookConfig<TInstructions, TAccounts>) {
  function useProgramMutation<TInstructionName extends keyof TInstructions>(
    input: UseProgramMutationInput<TInstructions, TAccounts, TInstructionName>,
  ) {
    const queryClient = useQueryClient();
    const { instruction, accounts, ...options } = input;
    const instructionFn = config.instructions[instruction];

    return useMutation({
      ...options,
      mutationFn: async (instructionInput?: Parameters<TInstructions[TInstructionName]>[0]) => {
        const finalInput = instructionInput || accounts || {};
        if (accounts && instructionInput) {
          Object.assign(finalInput, accounts);
        }

        const instruction = instructionFn(finalInput, {
          programAddress: config.programAddress,
        });

        instruction.accounts
          ?.map((account) => account.address)
          ?.forEach((address) => {
            void queryClient.invalidateQueries({
              queryKey: [GILL_HOOK_CLIENT_KEY, "account", address],
            });
          });

        return instruction;
      },
    });
  }

  function useProgramQuery<TAccountName extends keyof TAccounts>(input: UseProgramQueryInput<TAccounts, TAccountName>) {
    const { account, address, rpc, ...options } = input;
    const accountFetcher = config.accounts[account];

    return useQuery({
      ...options,
      queryKey: [GILL_HOOK_CLIENT_KEY, "account", account, address],
      queryFn: async () => {
        return accountFetcher(rpc, address);
      },
      enabled: options.enabled !== false && !!address && !!rpc,
    });
  }

  return {
    useProgramMutation,
    useProgramQuery,
  };
}
